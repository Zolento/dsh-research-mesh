/**
 * Trusted principals.
 *
 * DSH's plugin HTTP routes expose no verified user identity: the launch token
 * protects the application index, not third-party routes. Mesh therefore treats
 * every HTTP caller as an unauthenticated `web` principal and never upgrades a
 * request body into human authorization. Only host-side code that already runs
 * with the operator's authority may construct a `human` principal.
 *
 * This is a logical boundary inside one Node process, not an OS sandbox.
 */

import { MeshError } from '../errors.ts';

/** How a caller reached the autonomy engine. */
export type PrincipalKind = 'human' | 'system' | 'session' | 'web';

/** One authenticated-by-context caller. */
export interface Principal {
  readonly kind: PrincipalKind;
  readonly id: string;
  /** True only when the host established this principal out of band. */
  readonly authenticated: boolean;
  /** Provenance label for audit records. */
  readonly via: string;
}

/** The Mesh host itself: internal events, recovery, worker callbacks. */
export const SYSTEM_PRINCIPAL: Principal = Object.freeze({
  kind: 'system', id: 'mesh-host', authenticated: true, via: 'host',
});

/** An operator action passed through a verified host entry point. */
export function humanPrincipal(id = 'operator'): Principal {
  return { kind: 'human', id, authenticated: true, via: 'host-admin' };
}

/** A model or chat message; untrusted content that may propose but not authorize. */
export function sessionPrincipal(id: string): Principal {
  return { kind: 'session', id, authenticated: false, via: 'session' };
}

/** A browser request to a plugin route; no verified identity exists. */
export function webPrincipal(id = 'web-anonymous'): Principal {
  return { kind: 'web', id, authenticated: false, via: 'http' };
}

/**
 * Assert that a principal may exercise human-only authority.
 * @param principal - caller context.
 * @param action - action being attempted, for diagnostics.
 */
export function requireHuman(principal: Principal, action: string): void {
  if (principal.kind !== 'human' || !principal.authenticated) {
    throw new MeshError('PRINCIPAL_UNTRUSTED', `${action} requires a verified human operator`, {
      principal: principal.kind, id: principal.id, via: principal.via,
    });
  }
}

/**
 * Assert that the caller is the host or a verified human.
 * @param principal - caller context.
 * @param action - action being attempted.
 */
export function requireTrusted(principal: Principal, action: string): void {
  if (!principal.authenticated || (principal.kind !== 'human' && principal.kind !== 'system')) {
    throw new MeshError('PRINCIPAL_UNTRUSTED', `${action} requires a trusted caller`, {
      principal: principal.kind, id: principal.id, via: principal.via,
    });
  }
}

/** True when the principal is a verified human. */
export function isHuman(principal: Principal): boolean {
  return principal.kind === 'human' && principal.authenticated;
}
