/**
 * Running agent calls the user can watch and cancel, keyed by what they work on (a
 * scope for a generation, a change id for a change). Progress events are buffered for a
 * subscriber that connects while the work is already under way; a terminal event ends
 * every subscription and removes the job.
 *
 * Shared by the generation pipeline (`session.ts`) and the change manager, so the SSE
 * endpoints and the UI see one behaviour.
 */

/** Activity events kept for a subscriber that connects while the agent is already working. */
const DEFAULT_BUFFER = 40;

export type JobListener<E> = (event: E) => void;

/**
 * One running call. Shared by every request that joined the same key, so cancelling it
 * affects all of them — this is a single-user local tool.
 */
export interface Job<E> {
  readonly key: string;
  readonly startedAt: string;
  readonly controller: AbortController;
  /** `started` first, then the most recent activity; terminal events are not buffered. */
  events: E[];
  listeners: Set<JobListener<E>>;
  finished: boolean;
}

export class JobRegistry<E> {
  private readonly jobs = new Map<string, Job<E>>();

  constructor(private readonly buffer = DEFAULT_BUFFER) {}

  /**
   * Registers a job for `key` and emits its `started` event. A new job replaces the one
   * it overlaps (a refresh over a plain request); `finish` only removes the entry that
   * still belongs to the finishing job.
   */
  start(key: string, started: (startedAt: string) => E): Job<E> {
    const startedAt = new Date().toISOString();
    const job: Job<E> = {
      key,
      startedAt,
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
      finished: false,
    };
    this.jobs.set(key, job);
    this.emit(job, started(startedAt));
    return job;
  }

  emit(job: Job<E>, event: E): void {
    if (job.finished) return;
    job.events.push(event);
    // Keep `started` and the most recent activity; a late subscriber does not need the
    // whole history, only enough to see what the agent is doing now.
    if (job.events.length > this.buffer + 1) job.events.splice(1, job.events.length - this.buffer - 1);
    for (const listener of job.listeners) listener(event);
  }

  /** Delivers the terminal event to every subscriber and forgets the job. */
  finish(job: Job<E>, event: E): void {
    if (job.finished) return;
    for (const listener of job.listeners) listener(event);
    job.finished = true;
    job.listeners.clear();
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
  }

  /** The running job for `key`, or null. */
  get(key: string): Job<E> | null {
    const job = this.jobs.get(key);
    return job && !job.finished ? job : null;
  }

  /** Aborts the running job. False when nothing is running for the key. */
  cancel(key: string): boolean {
    const job = this.get(key);
    if (!job) return false;
    job.controller.abort();
    return true;
  }

  /**
   * Attaches to the running job: the buffered events are replayed, then live ones follow
   * until the terminal event. Null when nothing is running.
   */
  subscribe(key: string, listener: JobListener<E>): (() => void) | null {
    const job = this.get(key);
    if (!job) return null;
    for (const event of job.events) listener(event);
    job.listeners.add(listener);
    return () => {
      job.listeners.delete(listener);
    };
  }
}
