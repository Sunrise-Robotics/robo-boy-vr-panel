import assert from "node:assert/strict";
import test from "node:test";
import {
  connectWhep,
  deriveGatewayEndpoints,
  discoverGatewayStreams,
  normalizeWhepEndpoint,
  parseGatewayStreams,
  parseIceServers,
  isWebRtcSupported,
  parseIceServerLinks,
  resolveSessionUrl,
} from "../src/whep.ts";

test("normalizes relative WHEP endpoints and rejects non-HTTP transports", () => {
  assert.equal(
    normalizeWhepEndpoint(
      "/webrtc/camera/whep",
      "https://roboboy.test/workspace",
    ),
    "https://roboboy.test/webrtc/camera/whep",
  );
  assert.throws(
    () =>
      normalizeWhepEndpoint("rtsp://camera.local/live", "https://roboboy.test"),
    /HTTP or HTTPS/,
  );
});

// The host resolves where the gateway is; the panel appends a stream to it and never decides a
// host or a port for itself. Both shapes arrive absolute, because the host absolutises every
// endpoint it grants.
test("builds stream endpoints on whichever gateway the host resolved", () => {
  assert.deepEqual(
    deriveGatewayEndpoints(
      "https://roboboy.test/webrtc/",
      "genesis_wrist_camera",
    ),
    {
      whep: "https://roboboy.test/webrtc/genesis_wrist_camera/whep",
      rtsp: "rtsp://roboboy.test:8554/genesis_wrist_camera",
      hls: "",
    },
  );
  // A gateway of its own, which need not share a host or a port with anything else.
  assert.deepEqual(
    deriveGatewayEndpoints("http://gateway.local:18889/", "wrist_camera"),
    {
      whep: "http://gateway.local:18889/wrist_camera/whep",
      rtsp: "rtsp://gateway.local:8554/wrist_camera",
      hls: "",
    },
  );
});

test("refuses a stream path that would leave the gateway", () => {
  assert.throws(
    () => deriveGatewayEndpoints("https://roboboy.test/webrtc/", "../bad"),
    /invalid/,
  );
});

test("keeps only ready, valid, deduplicated gateway streams", () => {
  assert.deepEqual(
    parseGatewayStreams({
      items: [
        { name: "z_camera", ready: true, tracks: ["H264"] },
        { name: "offline", ready: false, tracks: ["H264"] },
        { name: "../invalid", ready: true },
        { name: "a_camera", ready: true, tracks: ["VP9", 42] },
        { name: "z_camera", ready: true, tracks: ["H264", "Opus"] },
      ],
    }),
    [
      { name: "a_camera", tracks: ["VP9"] },
      { name: "z_camera", tracks: ["H264", "Opus"] },
    ],
  );
  assert.deepEqual(parseGatewayStreams({ items: "invalid" }), []);
});

test("fetches gateway streams without caching", async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    return new Response(
      JSON.stringify({
        items: [
          { name: "manipulator_wrist_camera", ready: true, tracks: ["H264"] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await discoverGatewayStreams(
        "/webrtc/_discovery/paths",
        undefined,
        fetcher,
      ),
      [{ name: "manipulator_wrist_camera", tracks: ["H264"] }],
    );
  });
});

test("parses bounded STUN and TURN server lists", () => {
  assert.deepEqual(
    parseIceServers("stun:stun.example.org,\nturns:turn.example.org"),
    [{ urls: "stun:stun.example.org" }, { urls: "turns:turn.example.org" }],
  );
  assert.throws(
    () => parseIceServers("https://not-ice.example.org"),
    /Unsupported ICE/,
  );
});

test("parses WHEP ICE server links with temporary TURN credentials", () => {
  assert.deepEqual(
    parseIceServerLinks(
      '<turn:10.8.0.1:3478?transport=tcp>; rel="ice-server"; username="1787779000:session"; credential="temporary-secret", <stun:stun.example.org>; rel="ice-server"',
    ),
    [
      {
        urls: "turn:10.8.0.1:3478?transport=tcp",
        username: "1787779000:session",
        credential: "temporary-secret",
      },
      { urls: "stun:stun.example.org" },
    ],
  );
  assert.deepEqual(parseIceServerLinks(null), []);
  assert.deepEqual(
    parseIceServerLinks('<https://example.org>; rel="ice-server"'),
    [],
  );
});

test("resolves relative WHEP session resources", () => {
  assert.equal(
    resolveSessionUrl("https://camera.test/live/whep", "../session/42"),
    "https://camera.test/session/42",
  );
  assert.equal(resolveSessionUrl("https://camera.test/live/whep", null), null);
});

// Node defines no RTCPeerConnection, which is exactly the shape of a webview built without WebRTC.
test("refuses to negotiate where the webview has no WebRTC", async () => {
  assert.equal(isWebRtcSupported(), false);

  let requested = false;
  await assert.rejects(
    connectWhep({
      endpoint: "https://camera.test/live/whep",
      onTrack() {},
      fetcher: async () => {
        requested = true;
        throw new Error("the panel should not have reached the network");
      },
    }),
    /no WebRTC support/,
  );

  assert.equal(requested, false);
});

test("derives the HLS fallback only where the host published an endpoint", () => {
  assert.equal(
    deriveGatewayEndpoints(
      "http://gateway.local:8889/",
      "wrist_camera",
      "http://gateway.local:8888/",
    ).hls,
    "http://gateway.local:8888/wrist_camera/index.m3u8",
  );

  // A client behind a proxy is given no HLS endpoint, and needs none: it is a browser.
  assert.equal(
    deriveGatewayEndpoints("https://roboboy.test/webrtc/", "wrist_camera").hls,
    "",
  );
});
