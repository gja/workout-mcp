// A service we lean on is missing or failing: not the caller's fault, but theirs to be told plainly.

export class Unavailable extends Error {
  /** 502 when an upstream failed, 503 when this deployment lacks what it needs. */
  constructor(
    message: string,
    readonly status: 502 | 503,
  ) {
    super(message);
  }
}
