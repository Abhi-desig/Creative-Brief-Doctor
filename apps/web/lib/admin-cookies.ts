/**
 * Cookie names, and nothing else.
 *
 * Deliberately its own module with NO imports.
 *
 * `middleware.ts` needs the session cookie's name, and it runs in the Edge
 * Runtime. Importing that name from `admin-session.ts` pulled the whole module
 * into the edge bundle — including its `node:crypto` import, which the Edge
 * Runtime does not provide — and the middleware failed to compile, which took out
 * every route it matched with an unexplained 500. A single string constant was
 * enough to drag an incompatible dependency across a runtime boundary.
 *
 * Keeping the names here means both runtimes can agree on them without either
 * pulling in the other's dependencies. Nothing may be added to this file that
 * imports anything.
 */

export const ADMIN_SESSION_COOKIE = 'cbd_admin';
export const ADMIN_CSRF_COOKIE = 'csrf_token';
