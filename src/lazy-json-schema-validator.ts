import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

/** Keep AJV and its schema cache local to an actual validation, not every transient server. */
export const lazyJsonSchemaValidator: Pick<AjvJsonSchemaValidator, 'getValidator'> = {
  getValidator<T>(schema: Parameters<AjvJsonSchemaValidator['getValidator']>[0]) {
    return new AjvJsonSchemaValidator().getValidator<T>(schema);
  },
};
