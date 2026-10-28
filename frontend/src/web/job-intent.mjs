/** @typedef {{kind: 'transcribe' | 'summary', meeting_id: string, asset_id?: string, template_id?: string, language?: string}} JobPayload */

/** @param {JobPayload} payload */
function fingerprint(payload) {
  return JSON.stringify(Object.entries(payload).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right)));
}

export class PendingJobIntentError extends Error {
  constructor() {
    super('此前任务的提交结果尚未确认，参数已改变。请先查看任务队列，或明确确认创建一个可能再次收费的新任务。');
    this.name = 'PendingJobIntentError';
  }
}

/** Keeps the original billable intent until the server returns a confirmed job. */
export class JobIntent {
  /** @type {{request_id: string, payload: Readonly<JobPayload>} | undefined} */
  #pending;
  /** @param {() => string} [makeId] */
  constructor(makeId = () => globalThis.crypto.randomUUID()) { this.makeId = makeId; }
  get pending() { return this.#pending; }
  /** @param {JobPayload} payload */
  prepare(payload) {
    if (this.#pending) {
      if (fingerprint(this.#pending.payload) !== fingerprint(payload)) throw new PendingJobIntentError();
      return this.#pending;
    }
    this.#pending = Object.freeze({ request_id: this.makeId(), payload: Object.freeze({ ...payload }) });
    return this.#pending;
  }
  /**
   * A missing/mismatched response is still an unknown result, never a new intent.
   * @param {{id?: string, kind?: string, meeting_id?: string} | null | undefined} job
   */
  confirmResponse(job) {
    if (!this.#pending || typeof job?.id !== 'string' || !job.id || job.kind !== this.#pending.payload.kind || job.meeting_id !== this.#pending.payload.meeting_id) {
      throw new Error('任务提交结果尚未确认，请查看任务队列；再次提交时将核对同一个任务，不会另建收费任务。');
    }
    this.#pending = undefined;
  }
  /** Call only for an explicitly confirmed new intent, never for a network error. */
  resetForNewIntent() { this.#pending = undefined; }
}
