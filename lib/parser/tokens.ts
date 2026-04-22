import { LexerBuilder, createToken } from '@traqula/core';
import { lex as l12 } from '@traqula/rules-sparql-1-2';

export const viewToken = createToken({ name: 'View', pattern: /view/iu, label: 'VIEW' });
export const overToken = createToken({ name: 'Over', pattern: /over/iu, label: 'OVER' });
export const headToken = createToken({ name: 'Head', pattern: /head/iu, label: 'HEAD' });
export const bodyToken = createToken({ name: 'Body', pattern: /body/iu, label: 'BODY' });
export const monotoneToken = createToken({ name: 'Monotone', pattern: /monotone/iu, label: 'MONOTONE' });

export const viewLexerBuilder = LexerBuilder
  .create(l12.sparql12LexerBuilder)
  .add(viewToken, overToken, headToken, bodyToken, monotoneToken);
