/** Typed wrappers over the local HTTP API. */
import type {
  ApiError,
  CancelRequest,
  FileResponse,
  GraphResponse,
  OpenRepoRequest,
  ProgressEvent,
  RepoState,
} from '../shared/api';
import type { Level, Snapshot } from '../shared/graph';

/** The generation the request was waiting for was cancelled; there is no view to show. */
export class GenerationCancelled extends Error {
  constructor(message = 'Generation cancelled.') {
    super(message);
    this.name = 'GenerationCancelled';
  }
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const body = (await res.json().catch(() => ({}))) as T & Partial<ApiError>;
  if (!res.ok) {
    if (body.error === 'cancelled') throw new GenerationCancelled(body.detail);
    throw new Error([body.error ?? `Request failed (${res.status})`, body.detail].filter(Boolean).join(' — '));
  }
  return body;
}

const post = <T>(url: string, body: unknown) =>
  json<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const getState = () => json<RepoState>('/api/state');

export const openRepo = (path: string) => {
  const body: OpenRepoRequest = { path };
  return post<RepoState>('/api/repo', body);
};

export const getSnapshot = () => json<Snapshot>('/api/snapshot');

const graphQuery = (level: Level, scopeId: string) => `level=${level}&scope=${encodeURIComponent(scopeId)}`;

export const getGraph = (level: Level, scopeId: string, refresh = false) =>
  json<GraphResponse>(`/api/graph?${graphQuery(level, scopeId)}${refresh ? '&refresh=1' : ''}`);

export const cancelGeneration = (level: Level, scopeId: string) => {
  const body: CancelRequest = { level, scopeId };
  return post<{ cancelled: boolean }>('/api/graph/cancel', body);
};

/**
 * Follows the progress of a running generation over SSE. The server ends the stream
 * after the terminal event, or after a single `idle` event when nothing is running —
 * the caller decides whether to try again. `onDrop` fires when the connection ended
 * before any such event arrived (a network hiccup), so the caller can reconnect.
 * Returns a function that closes the stream.
 */
export function subscribeProgress(
  level: Level,
  scopeId: string,
  onEvent: (event: ProgressEvent) => void,
  onDrop?: () => void,
): () => void {
  const source = new EventSource(`/api/graph/progress?${graphQuery(level, scopeId)}`);
  let ended = false;
  const handle = (message: MessageEvent<string>) => {
    let event: ProgressEvent;
    try {
      event = JSON.parse(message.data) as ProgressEvent;
    } catch {
      return;
    }
    if (event.type !== 'started' && event.type !== 'activity') {
      ended = true;
      source.close();
    }
    onEvent(event);
  };
  source.addEventListener('progress', handle as EventListener);
  // EventSource reconnects on its own after the server closes the stream; the stream is
  // single-use here, so a closed connection is the end of it.
  source.onerror = () => {
    source.close();
    if (!ended) {
      ended = true;
      onDrop?.();
    }
  };
  return () => {
    ended = true;
    source.close();
  };
}

export const getFile = (path: string) => json<FileResponse>(`/api/file?path=${encodeURIComponent(path)}`);
