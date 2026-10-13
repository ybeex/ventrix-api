/**
 * The two Ajv configurations used across the API (see app.ts for why they differ):
 *   bodyAjv    — NO coercion. JSON bodies must match their schema exactly (null never becomes 0/false/"").
 *   requestAjv — coerces query strings / params / headers, which arrive as text.
 * Also used by the offline-sync service to validate queued payloads with the SAME rules as the online endpoints.
 */
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';

// ajv-formats is CommonJS; under NodeNext its callable lives on `.default`.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;
const make = (coerce: boolean) => {
  const ajv = new Ajv({ removeAdditional: false, coerceTypes: coerce ? 'array' : false, useDefaults: true, allErrors: false });
  addFormats(ajv);
  return ajv;
};
export const bodyAjv = make(false);
export const requestAjv = make(true);
