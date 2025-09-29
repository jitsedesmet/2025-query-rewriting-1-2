import { DataFactory } from 'rdf-data-factory';

export const DF = new DataFactory();

export const xsd = 'http://www.w3.org/2001/XMLSchema#';
export const datatypeBoolean = DF.namedNode(`${xsd}boolean`);
export const termFalse = DF.literal('false', datatypeBoolean);
