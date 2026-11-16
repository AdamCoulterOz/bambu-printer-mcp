import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
/** Keep AJV and its schema cache local to an actual validation, not every transient server. */
export declare const lazyJsonSchemaValidator: Pick<AjvJsonSchemaValidator, 'getValidator'>;
