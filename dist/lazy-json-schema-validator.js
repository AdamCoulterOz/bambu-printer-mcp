import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
/** Keep AJV and its schema cache local to an actual validation, not every transient server. */
export const lazyJsonSchemaValidator = {
    getValidator(schema) {
        return new AjvJsonSchemaValidator().getValidator(schema);
    },
};
