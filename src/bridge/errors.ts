/**
 * Error vocabulary for the Research Team Bridge.
 *
 * Every failure that a caller may need to branch on is expressed as a stable
 * {@link RtbErrorCode}. Both the transport and the domain layers raise the same
 * class so a tool handler can map any bridge failure to one honest message
 * instead of leaking a DSH internal.
 *
 * @module dsh-research-team-bridge/errors
 */

import type { MessageRejectionCode, StateGateCode, TaskErrorCode } from './types.ts'

/** Stable machine-readable codes. Never renumber or reuse. */
export type RtbErrorCode =
  | 'CONFIG_INVALID'
  | 'HOST_VERSION_UNSUPPORTED'
  | 'HOST_CAPABILITY_MISSING'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_ALREADY_ACTIVE'
  | 'TEAM_BUDGET_EXHAUSTED'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_ALREADY_EXISTS'
  | 'MEMBER_FAILED'
  | 'TRANSPORT_UNSUPPORTED'
  | 'TRANSPORT_FAILED'
  | 'DELIVERY_REJECTED'
  | 'IDENTITY_MISMATCH'
  | 'PERMISSION_DENIED'
  | 'STATE_GATE_HOLD'
  | 'STORE_CONFLICT'
  | 'RECOVERY_HOLD'
  | 'PIPELINE_UNAVAILABLE'
  | 'PIPELINE_FAILED'
  | 'SCHEMA_INVALID'
  | 'NOT_IMPLEMENTED'
  /** An unexpected throw: a fault the bridge has no specific vocabulary for. */
  | 'INTERNAL_FAULT'

/** Union of every code a bridge error may carry, including domain sub-codes. */
export type AnyRtbErrorCode = RtbErrorCode | MessageRejectionCode | TaskErrorCode | StateGateCode

export interface RtbErrorDetails {
  readonly [key: string]: unknown
}

/**
 * One bridge failure. `details` is JSON-serializable so it can be journalled
 * and returned verbatim in a tool result.
 */
export class RtbError extends Error {
  readonly code: AnyRtbErrorCode
  readonly details: RtbErrorDetails
  readonly safe: string

  constructor(code: AnyRtbErrorCode, message: string, details: RtbErrorDetails = {}) {
    super(message)
    this.name = 'RtbError'
    this.code = code
    this.details = details
    this.safe = `${code}: ${message}`
  }

  /** Serialize for journalling or a tool result. */
  toJSON(): { code: AnyRtbErrorCode; message: string; details: RtbErrorDetails } {
    return { code: this.code, message: this.message, details: this.details }
  }
}

/** Type guard used at catch sites. */
export function isRtbError(value: unknown): value is RtbError {
  return value instanceof RtbError
}

/** Normalize any thrown value into an RtbError. */
export function asRtbError(value: unknown, fallbackCode: RtbErrorCode = 'TRANSPORT_FAILED'): RtbError {
  if (value instanceof RtbError) return value
  if (value instanceof Error) return new RtbError(fallbackCode, value.message, { name: value.name })
  return new RtbError(fallbackCode, String(value))
}

/**
 * Map any thrown value to a stable code and a message safe to hand a caller.
 *
 * `NOT_IMPLEMENTED` is the honest code for "the bridge hit a fault it does not have
 * a vocabulary for"; it is not `TRANSPORT_FAILED`, which promised a retry would help.
 */
export function describeInternalFault(value: unknown): { code: AnyRtbErrorCode; message: string } {
  const error = asRtbError(value)
  return { code: error.code, message: error.message }
}

/** Human-readable one-line rendering used in tool output. */
export function describeError(value: unknown): string {
  return asRtbError(value).safe
}

/** A HOLD is not a crash: the bridge refuses to guess and reports why. */
export class RtbHold extends RtbError {
  constructor(code: AnyRtbErrorCode, message: string, details: RtbErrorDetails = {}) {
    super(code, message, details)
    this.name = 'RtbHold'
  }
}
