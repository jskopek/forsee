import { ForseeError, validateSettingFields, type Kernel } from '@forsee/core';
import type { Disposable, SettingField } from '@forsee/plugin-api';

/**
 * Holds a plugin's settings schema (namespace = plugin id) and its
 * `settings` contribution, so the manifest's `contributes.settings` and a
 * later `api.settings.registerSchema` replace each other instead of
 * clashing. Stored values survive a replacement (the settings registry keeps them).
 */
export class SettingsSchemaSlot implements Disposable {
  private registration: Disposable[] = [];

  constructor(
    private readonly kernel: Kernel,
    private readonly pluginId: string,
    private readonly title: string,
  ) {}

  /** Registers `fields`, replacing any earlier schema. Throws like `SettingsRegistry.registerSchema`. */
  replace(fields: readonly SettingField[]): void {
    const issues = validateSettingFields(fields);
    if (issues.length > 0) {
      throw new ForseeError('invalid-argument', `Invalid settings schema for ${this.pluginId}`, {
        details: issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    this.dispose();
    const schema = this.kernel.settings.registerSchema(this.pluginId, fields);
    try {
      const contribution = this.kernel.extensions.register('settings', this.pluginId, {
        id: this.pluginId,
        title: this.title,
        fields,
      });
      this.registration = [contribution, schema];
    } catch (error) {
      schema.dispose();
      throw error;
    }
  }

  dispose(): void {
    const items = this.registration;
    this.registration = [];
    for (const item of items) item.dispose();
  }
}
