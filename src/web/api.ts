/** Typed wrappers over the local HTTP API. */
import type {
  ApiError,
  ApplyRequest,
  ApplyResponse,
  CancelRequest,
  ChangeProgressEvent,
  ChangeRequest,
  ChangeStartResponse,
  ChangeStatus,
  ContextRequest,
  ContextResponse,
  FileResponse,
  GraphResponse,
  OpenRepoRequest,
  ProgressEvent,
  RefineRequest,
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
 * Follows a job's progress stream over SSE. The server ends the stream after the
 * terminal event, or after a single `idle` event when nothing is running — the caller
 * decides whether to try again. `onDrop` fires when the connection ended before any such
 * event arrived (a network hiccup), so the caller can reconnect. Returns a function that
 * closes the stream.
 */
function subscribeStream<E extends { type: string }>(url: string, onEvent: (event: E) => void, onDrop?: () => void): () => void {
  const source = new EventSource(url);
  let ended = false;
  const handle = (message: MessageEvent<string>) => {
    let event: E;
    try {
      event = JSON.parse(message.data) as E;
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

/** The progress of a running generation (see `subscribeStream`). */
export const subscribeProgress = (level: Level, scopeId: string, onEvent: (event: ProgressEvent) => void, onDrop?: () => void) =>
  subscribeStream<ProgressEvent>(`/api/graph/progress?${graphQuery(level, scopeId)}`, onEvent, onDrop);

export const getFile = (path: string) => json<FileResponse>(`/api/file?path=${encodeURIComponent(path)}`);

/** The structured context of a selection, as the server computes it from its loaded views. */
export const getContext = (req: ContextRequest) => post<ContextResponse>('/api/context', req);

/** The same context rendered as Markdown by the server. */
export async function getContextMarkdown(req: ContextRequest): Promise<string> {
  const res = await fetch('/api/context?format=markdown', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<ApiError>;
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.text();
}

/* ---- Prompt → Change → Verify ------------------------------------------------------ */

const changeUrl = (id: string, tail = '') => `/api/change/${encodeURIComponent(id)}${tail}`;

export const startChange = (req: ChangeRequest) => post<ChangeStartResponse>('/api/change', req);

export const getChange = (id: string) => json<ChangeStatus>(changeUrl(id));

/** The progress of the change's running agent (see `subscribeStream`). */
export const subscribeChangeProgress = (id: string, onEvent: (event: ChangeProgressEvent) => void, onDrop?: () => void) =>
  subscribeStream<ChangeProgressEvent>(changeUrl(id, '/progress'), onEvent, onDrop);

export const cancelChange = (id: string) => post<{ cancelled: boolean }>(changeUrl(id, '/cancel'), {});

export const refineChange = (id: string, task: string) => {
  const body: RefineRequest = { task };
  return post<ChangeStatus>(changeUrl(id, '/refine'), body);
};

export const applyChange = (id: string, confirmOutside = false) => {
  const body: ApplyRequest = confirmOutside ? { confirmOutside } : {};
  return post<ApplyResponse>(changeUrl(id, '/apply'), body);
};

export const discardChange = (id: string) => post<ChangeStatus>(changeUrl(id, '/discard'), {});
