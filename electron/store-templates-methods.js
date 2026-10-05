"use strict";

const { randomUUID } = require("node:crypto");
const { clonePhases, ensureWorkflowTemplates } = require("./store-migrate.js");

/** Store workflow-template methods; store.js copies them onto Store.prototype. */
class StoreTemplateMethods {
  /**
   * @returns {object[]} deep clones of all workflow templates
   */
  listTemplates() {
    ensureWorkflowTemplates(this.data);
    return this.data.workflowTemplates.map((t) =>
      JSON.parse(JSON.stringify(t)),
    );
  }

  /**
   * Get one template by id (deep clone), or null.
   * @param {string} id
   */
  getTemplate(id) {
    ensureWorkflowTemplates(this.data);
    const t = this.data.workflowTemplates.find((x) => x && x.id === id);
    return t ? JSON.parse(JSON.stringify(t)) : null;
  }

  /**
   * Save a workflow template.
   * - No id: create with a new uuid, builtin false.
   * - Builtin id: create a COPY (new id, builtin false); name gets " (copy)"
   *   unless the caller supplied a different name from the builtin.
   * - Non-builtin id that exists: update in place.
   * - Unknown non-builtin id: create with that id.
   * Does not validate phase contents; services layer owns validation.
   * Does not save to disk; caller must save.
   *
   * @param {{ id?: string, name: string, phases: object[], builtin?: boolean }} template
   * @returns {object} the saved template (deep clone)
   */
  saveTemplate(template) {
    ensureWorkflowTemplates(this.data);
    if (!template || typeof template !== "object") {
      throw new Error("template is required");
    }
    const name = template.name != null ? String(template.name) : "";
    const phases = clonePhases(template.phases);
    const list = this.data.workflowTemplates;

    if (template.id == null || template.id === "") {
      const created = {
        id: randomUUID(),
        name,
        builtin: false,
        phases,
      };
      list.push(created);
      return JSON.parse(JSON.stringify(created));
    }

    const id = String(template.id);
    const existing = list.find((t) => t && t.id === id);

    if (existing && existing.builtin) {
      const renamed =
        name.length > 0 && name !== String(existing.name || "");
      const copy = {
        id: randomUUID(),
        name: renamed ? name : `${existing.name} (copy)`,
        builtin: false,
        phases: phases.length > 0 ? phases : clonePhases(existing.phases),
      };
      list.push(copy);
      return JSON.parse(JSON.stringify(copy));
    }

    if (existing) {
      existing.name = name;
      existing.phases = phases;
      existing.builtin = false;
      return JSON.parse(JSON.stringify(existing));
    }

    const created = {
      id,
      name,
      builtin: false,
      phases,
    };
    list.push(created);
    return JSON.parse(JSON.stringify(created));
  }

  /**
   * Remove a non-builtin template. Rejects builtin templates.
   * Does not save; caller must save.
   * @param {string} id
   */
  removeTemplate(id) {
    ensureWorkflowTemplates(this.data);
    const tid = String(id);
    const existing = this.data.workflowTemplates.find(
      (t) => t && t.id === tid,
    );
    if (!existing) {
      throw new Error(`Unknown template: ${tid}`);
    }
    if (existing.builtin) {
      throw new Error(`Cannot remove builtin template: ${tid}`);
    }
    this.data.workflowTemplates = this.data.workflowTemplates.filter(
      (t) => !t || t.id !== tid,
    );
  }
}

module.exports = StoreTemplateMethods;
