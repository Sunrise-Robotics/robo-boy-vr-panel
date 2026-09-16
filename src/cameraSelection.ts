import type { GatewayStream } from './whep';

export const MAX_SELECTED_STREAMS = 5;
export const INITIAL_SELECTED_STREAMS = 2;

/** Select a predictable, lightweight starting view without assuming camera names. */
export const defaultSelectedStreamNames = (
  streams: readonly GatewayStream[],
): Set<string> => new Set(streams.slice(0, INITIAL_SELECTED_STREAMS).map((stream) => stream.name));

export const canSelectStream = (
  selectedStreamNames: ReadonlySet<string>,
  streamName: string,
): boolean => selectedStreamNames.has(streamName) || selectedStreamNames.size < MAX_SELECTED_STREAMS;
