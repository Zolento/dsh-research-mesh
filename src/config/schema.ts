/**
 * Cordis/Schemastery Config for the plugin.
 *
 * Only `modelAssignments` is volatile: it is the one field the custom WebUI
 * settings page mutates through the DSH Settings Service. Every other plugin
 * field remains ordinary composition configuration and is intentionally not
 * exposed as an editable form field.
 */

import z from '@deepseek-ai/schemastery';

/** One model route in the settings document. */
export const ModelChoiceSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
});

/** One group's manual model assignment. */
export const GroupAssignmentSchema = z.object({
  default: z.union([ModelChoiceSchema, z.const(undefined)]),
  captain: z.union([ModelChoiceSchema, z.const('inherit' as const)]).default('inherit'),
  subagents: z.dict(z.union([ModelChoiceSchema, z.const('inherit' as const)])).default({}),
});

/** The single volatile model-assignment document. */
export const ModelAssignmentsSchema = z.object({
  version: z.natural().default(1),
  groups: z.dict(GroupAssignmentSchema).default({}),
}).default({ version: 1, groups: {} }).volatile();

/** Plugin Config. Unknown non-volatile fields are preserved by Cordis. */
export const Config = z.object({
  modelAssignments: ModelAssignmentsSchema,
});
