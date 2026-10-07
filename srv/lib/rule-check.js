'use strict';
// Consistency check for ValidationRules maintained by administrators (spec §3.7).
// A rule the engine cannot evaluate (e.g. a broken regex) would silently never fire, so it is rejected on save.
const cds = require('@sap/cds');
const { SHEETS } = require('./template');

const ENTITIES = Object.values(SHEETS).map((s) => s.entity);
const NUMBER = /^-?\d+(\.\d+)?$/;

/** Returns an error text, or null when the rule is usable. */
function checkRule(rule) {
  if (!rule.ruleCode?.trim()) return 'ruleCode is required';
  if (!rule.messageText?.trim()) return 'messageText is required';
  if (!ENTITIES.includes(rule.entityName)) return `entityName must be one of ${ENTITIES.join(', ')}`;

  const element = cds.entities('mmc')[rule.entityName].elements[rule.fieldName];
  if (!element || element.isAssociation || element.virtual) return `${rule.fieldName} is not a field of ${rule.entityName}`;

  const parameter = rule.parameter?.trim() ?? '';
  switch (rule.ruleType) {
    case 'REQUIRED':
      return null;
    case 'LENGTH':
    case 'RANGE': {
      const parts = parameter.split(',').map((p) => p.trim());
      if (parts.length !== 2 || !parts.every((p) => NUMBER.test(p))) return `${rule.ruleType} needs the parameter "min,max"`;
      return Number(parts[0]) > Number(parts[1]) ? 'min must not exceed max' : null;
    }
    case 'REGEX':
      try { new RegExp(parameter); } catch (e) { return `parameter is not a valid regular expression: ${e.message}`; }
      return parameter ? null : 'REGEX needs a pattern as parameter';
    case 'LOOKUP':
      return /^[A-Z0-9_]+$/.test(parameter) ? null : 'LOOKUP needs a value help category (e.g. PLANT) as parameter';
    default:
      return 'ruleType is required';
  }
}

module.exports = { checkRule };
