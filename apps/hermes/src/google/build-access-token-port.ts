import type { GoogleAccountRepo, RefreshCoordinator } from "@hermes/google-auth";
import { type Pool, updateRefreshedTokens } from "@hermes/store";

/**
 * The port shape shared by every consumer's own injected `AccessTokenPort`
 * (`@hermes/google-sheets`, `@hermes/google-gmail`, and — structurally, not
 * by import — `@hermes/google-calendar`'s own binding). Declared locally
 * rather than imported from any one consumer package, since this binder is
 * shared by more than one and no consumer package should be privileged as
 * "the" source of the shape.
 */
export interface GoogleAccessTokenPort {
  getAccessToken(channel: string, channelUserId: string): Promise<string>;
}

export interface BuildAccessTokenPortDeps {
  pool: Pool;
  googleAccountRepo: GoogleAccountRepo;
  refreshCoordinator: RefreshCoordinator;
}

/**
 * Binds a consumer package's injected `AccessTokenPort` (structurally
 * identical to `GoogleAccessTokenPort` above) to the existing refresh seam —
 * `RefreshCoordinator.getValidAccessToken`, the same one `apps/hermes/src/
 * google/refresh-sweep.ts` uses — rather than a second refresh path (settled
 * decision 18). Used by `boot.ts`'s `buildSheetsDeps` and `buildGmailDeps`
 * (`@hermes/google-calendar` has its own twin,
 * `build-calendar-access-token-port.ts`, for the same reason). A missing
 * account throws: a tool only ever reaches this port after
 * `withRequiredScopes` (`apps/hermes/src/agent/with-required-scopes.ts`) has
 * already confirmed a connected, sufficiently-scoped account exists, so this
 * is a defensive backstop against a call site bypassing that gate, not a
 * real path.
 *
 * Persists a refreshed account via the same **UPDATE-only**
 * `updateRefreshedTokens` `refresh-sweep.ts` uses — never `upsertAccount` —
 * so a token refresh in flight can never resurrect an account
 * `/disconnect` deleted meanwhile. Only persists when a refresh actually
 * happened: `getValidAccessToken` returns the very same `account` object
 * (reference-equal) on the fresh path, and only builds a new one on an
 * actual refresh (`packages/google-auth/src/refresh.ts`) — comparing
 * references avoids writing back an unchanged token envelope on every tool
 * call.
 */
export function buildAccessTokenPort(deps: BuildAccessTokenPortDeps): GoogleAccessTokenPort {
  return {
    async getAccessToken(channel: string, channelUserId: string): Promise<string> {
      const account = await deps.googleAccountRepo.getAccount(channel, channelUserId);
      if (!account) {
        throw new Error(
          `no Google account connected for ${channel}:${channelUserId} — cannot fetch a Google access token`,
        );
      }

      const result = await deps.refreshCoordinator.getValidAccessToken(account);
      if (result.account !== account) {
        await updateRefreshedTokens(deps.pool, result.account);
      }
      return result.accessToken;
    },
  };
}
