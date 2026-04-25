/**
 * FILE: extension/entrypoints/options/main.ts
 * PURPOSE: Bootstrap the full-size options page settings surface.
 * OWNS: Options-page startup for the shared settings and approvals UI.
 * EXPORTS: none
 * DOCS: agent_chat/plan_ui_approval_flow_2026-05-10.md
 */

import { bootstrapSettingsSurface } from "../../src/ui/settings-surface";

bootstrapSettingsSurface("options");
