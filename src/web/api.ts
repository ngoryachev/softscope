/** Typed wrappers over the local HTTP API. */
import type { ApiError, FileResponse, GraphResponse, OpenRepoRequest, RepoState } from '../shared/api';
import type { Level, Snapshot } from '../shared/graph';

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const body = (await res.json().catch(() => ({}))) as T & Partial<ApiError>;
  if (!res.ok) {
    throw new Error([body.error ?? `Request failed (${res.status})`, body.detail].filter(Boolean).join(' — '));
  }
  return body;
}

export const getState = () => json<RepoState>('/api/state');

export const openRepo = (path: string) => {
  const body: OpenRepoRequest = { path };
  return json<RepoState>('/api/repo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
};

export const getSnapshot = () => json<Snapshot>('/api/snapshot');

export const getGraph = (level: Level, scopeId: string, refresh = false) =>
  json<GraphResponse>(
    `/api/graph?level=${level}&scope=${encodeURIComponent(scopeId)}${refresh ? '&refresh=1' : ''}`,
  );

export const getFile = (path: string) => json<FileResponse>(`/api/file?path=${encodeURIComponent(path)}`);
