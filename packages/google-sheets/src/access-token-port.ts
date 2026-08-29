/**
 * The injected token seam — declared here, in the consumer, per this
 * codebase's consumer-declares-its-port convention (see
 * `@hermes/google-auth`'s `GoogleAccountRepo`). `apps/hermes/src/google/
 * build-access-token-port.ts` binds this to `@hermes/google-auth`'s
 * `RefreshCoordinator.getValidAccessToken` — the single refresh seam
 * `04-google-auth` Phase 4 built specifically so a request-path tool call
 * like this one would never need a second refresh path (settled decision
 * 18). `packages/google-sheets` never imports `@hermes/google-auth` or
 * `@hermes/store` directly.
 */
export interface AccessTokenPort {
  getAccessToken(channel: string, channelUserId: string): Promise<string>;
}
