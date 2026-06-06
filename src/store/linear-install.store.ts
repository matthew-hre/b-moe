import { z } from "zod";

export const LinearInstallSchema = z
  .object({
    appUserId: z.string().min(1),
    accessToken: z.string().min(1),
    scope: z.union([z.string(), z.array(z.string())]),
    expiresAt: z.date().optional(),
    refreshToken: z.string().min(1).optional(),
  })
  .strict();

export type LinearInstall = Readonly<z.infer<typeof LinearInstallSchema>>;

export interface LinearInstallStore {
  // Persist the app's install for a workspace, keyed by its per-workspace app
  // user id. Single-tenant per deployment for now, but keyed so a dev and prod
  // install never collide.
  saveInstall(install: LinearInstall): Promise<LinearInstall>;
  getInstall(appUserId?: string): Promise<LinearInstall | undefined>;
}

// Phase 1 store: in-memory while the deployment settles. Phase 2 should persist
// installs in Redis behind this same interface.
export class InMemoryLinearInstallStore implements LinearInstallStore {
  private readonly installs = new Map<string, LinearInstall>();

  async saveInstall(install: LinearInstall): Promise<LinearInstall> {
    const parsedInstall = LinearInstallSchema.parse(install);

    this.installs.set(parsedInstall.appUserId, parsedInstall);

    return parsedInstall;
  }

  async getInstall(appUserId?: string): Promise<LinearInstall | undefined> {
    if (appUserId) {
      const install = this.installs.get(appUserId);

      return install ? LinearInstallSchema.parse(install) : undefined;
    }

    // Single-tenant convenience: return the only install when no id is given.
    const [install] = this.installs.values();

    return install ? LinearInstallSchema.parse(install) : undefined;
  }
}
