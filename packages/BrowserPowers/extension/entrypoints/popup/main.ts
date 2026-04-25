/**
 * FILE: extension/entrypoints/popup/main.ts
 * PURPOSE: Bootstrap the popup settings surface.
 * OWNS: Popup-specific startup for the shared settings and approvals UI.
 * EXPORTS: none
 * DOCS: agent_chat/plan_ui_approval_flow_2026-05-10.md
 */

import { bootstrapSettingsSurface } from "../../src/ui/settings-surface";

// Hide loading spinner once init starts
const loading = document.getElementById("loading");
if (loading) loading.style.display = "none";

bootstrapSettingsSurface("popup");
