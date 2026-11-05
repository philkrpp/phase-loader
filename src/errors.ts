/**
 * The only error this package throws on purpose. Messages name keys, apps, paths, accounts and status codes only,
 * never a secret value or a token.
 */
export class PhaseLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseLoaderError";
  }
}
