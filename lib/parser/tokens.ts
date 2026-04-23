/* eslint-disable require-unicode-regexp */
import { LexerBuilder, createToken } from '@traqula/core';
import { lex as l12 } from '@traqula/rules-sparql-1-2';

export const viewToken = createToken({ name: 'View', pattern: /view/i, label: 'VIEW' });
export const overToken = createToken({ name: 'Over', pattern: /over/i, label: 'OVER' });
export const headToken = createToken({ name: 'Head', pattern: /head/i, label: 'HEAD' });
export const bodyToken = createToken({ name: 'Body', pattern: /body/i, label: 'BODY' });
export const monotoneToken = createToken({ name: 'Monotone', pattern: /monotone/i, label: 'MONOTONE' });

export const viewLexerBuilder = LexerBuilder
  .create(l12.sparql12LexerBuilder)
  .add(viewToken, overToken, headToken, bodyToken, monotoneToken);
