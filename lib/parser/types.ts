import type { Node, Patch } from '@traqula/core';
import type * as T12 from '@traqula/rules-sparql-1-2';

/** A single HEAD/BODY pair in a VIEW definition */
export type ViewPair = {
  head: T12.PatternBgp;
  body: T12.PatternGroup;
};

/** A VIEW definition node in the query prologue */
export type ContextDefinitionView = Node & {
  type: 'contextDef';
  subType: 'view';
  /** IRI of this view */
  name: T12.TermIri;
  /** Whether the MONOTONE keyword was present */
  monotone: boolean;
  /** One or more HEAD/BODY pairs */
  pairs: ViewPair[];
};

/** An OVER query pattern node */
export type PatternOver = T12.PatternBase & {
  subType: 'over';
  /** IRI of the view to expand */
  name: T12.TermIri;
  /** The graph pattern whose BGP triples are matched against the VIEW HEAD */
  pattern: PatternGroup;
};

// =====================================================================================================================
// ========================================= Redefining what exists ====================================================
// =====================================================================================================================

export type Sparql12Nodes =
  | GraphRef
  | UpdateOperation
  | Update
  | Query
  | DatasetClauses
  | TripleCollection
  | TripleNesting
  | Pattern
  | SolutionModifier
  | Expression
  | Path
  | ContextDefinition
  | Wildcard
  | Term;

export type GraphRefBase = T12.GraphRefBase;
export type GraphRefDefault = T12.GraphRefDefault;
export type GraphRefNamed = T12.GraphRefNamed;
export type GraphRefAll = T12.GraphRefAll;
export type GraphRefSpecific = T12.GraphRefSpecific;
export type GraphRef = T12.GraphRef;
export type Quads = T12.PatternBgp;

// https://www.w3.org/TR/sparql11-query/#rUpdate1
export type UpdateOperationBase = T12.UpdateOperationBase;
export type UpdateOperationLoad = T12.UpdateOperationLoad;
export type UpdateOperationClear = T12.UpdateOperationCreate;
export type UpdateOperationDrop = T12.UpdateOperationDrop;
export type UpdateOperationCreate = T12.UpdateOperationCreate;
export type UpdateOperationAdd = T12.UpdateOperationAdd;
export type UpdateOperationMove = T12.UpdateOperationMove;
export type UpdateOperationCopy = T12.UpdateOperationCopy;
export type UpdateOperationInsertData = T12.UpdateOperationInsertData;
export type UpdateOperationDeleteData = T12.UpdateOperationDeleteData;
export type UpdateOperationDeleteWhere = T12.UpdateOperationDeleteWhere;
export type UpdateOperationModify = Patch<T12.UpdateOperationModify, { where: PatternGroup }>;
export type UpdateOperation =
  | UpdateOperationLoad
  | UpdateOperationClear
  | UpdateOperationDrop
  | UpdateOperationCreate
  | UpdateOperationAdd
  | UpdateOperationMove
  | UpdateOperationCopy
  | UpdateOperationInsertData
  | UpdateOperationDeleteData
  | UpdateOperationDeleteWhere
  | UpdateOperationModify;

// https://www.w3.org/TR/sparql11-query/#rUpdate
export type Update = Node & {
  type: 'update';
  updates: {
    operation?: UpdateOperation;
    context: ContextDefinition[];
  }[];
};

// https://www.w3.org/TR/sparql11-query/#rQueryUnit
export type QueryBase = Patch<T12.QueryBase, { context: ContextDefinition[]; where?: PatternGroup }>;
export type QuerySelect = Patch<T12.QuerySelect, { context: ContextDefinition[]; where: PatternGroup }>;
export type QueryConstruct = Patch<T12.QueryConstruct, { context: ContextDefinition[]; where: PatternGroup }>;
export type QueryDescribe = Patch<T12.QueryDescribe, { context: ContextDefinition[]; where?: PatternGroup }>;
export type QueryAsk = Patch<T12.QueryAsk, { context: ContextDefinition[]; where: PatternGroup }>;
export type Query =
  | QuerySelect
  | QueryConstruct
  | QueryDescribe
  | QueryAsk;

export type SparqlQuery = Query | Update;

export type DatasetClauses = T12.DatasetClauses;
export type TripleCollectionBase = T12.TripleCollectionBase;
export type TripleCollectionList = T12.TripleCollectionList;
/**
 * The subject of the triples does not have a string manifestation.
 */
export type TripleCollectionBlankNodeProperties = T12.TripleCollectionBlankNodeProperties;
export type TripleCollectionReifiedTriple = T12.TripleCollectionReifiedTriple;

export type TripleCollection =
  | TripleCollectionList
  | TripleCollectionBlankNodeProperties
  | TripleCollectionReifiedTriple;

// https://www.w3.org/TR/sparql11-query/#rGraphNode
export type GraphNode = T12.GraphNode;
export type Annotation = T12.Annotation;
// https://www.w3.org/TR/sparql12-query/#rTriplesBlock
export type TripleNesting = T12.TripleNesting;

export type PatternBase = T12.PatternBase;
export type PatternFilter = T12.PatternFilter;
export type PatternMinus = Patch<T12.PatternMinus, { patterns: Pattern[] }>;
export type PatternGroup = Patch<T12.PatternGroup, { patterns: Pattern[] }>;
export type PatternOptional = Patch<T12.PatternOptional, { patterns: Pattern[] }>;
export type PatternGraph = Patch<T12.PatternGraph, { patterns: Pattern[] }>;
export type PatternUnion = Patch<T12.PatternUnion, { patterns: PatternGroup[] }>;
export type BasicGraphPattern = T12.BasicGraphPattern;
export type PatternBgp = T12.PatternBgp;
export type PatternBind = T12.PatternBind;
export type PatternService = Patch<T12.PatternService, { patterns: Pattern[] }>;
/**
 * A single list of assignments maps the variable identifier to the value
 */
export type ValuePatternRow = T12.ValuePatternRow;
export type PatternValues = T12.PatternValues;
export type SubSelect = QuerySelect;

export type Pattern =
  | PatternOver
  | PatternBgp
  | PatternGroup
  | PatternUnion
  | PatternOptional
  | PatternMinus
  | PatternGraph
  | PatternService
  | PatternFilter
  | PatternBind
  | PatternValues
  | SubSelect;

export type SolutionModifiers = T12.SolutionModifiers;
export type SolutionModifierBase = T12.SolutionModifierBase;
export type SolutionModifierGroupBind = T12.SolutionModifierGroupBind;
export type SolutionModifierGroup = T12.SolutionModifierGroup;
export type SolutionModifierHaving = T12.SolutionModifierHaving;
export type Ordering = T12.Ordering;
export type SolutionModifierOrder = T12.SolutionModifierOrder;
export type SolutionModifierLimitOffset = T12.SolutionModifierLimitOffset;

export type SolutionModifier =
  | SolutionModifierGroup
  | SolutionModifierHaving
  | SolutionModifierOrder
  | SolutionModifierLimitOffset;

export type ExpressionBase = T12.ExpressionBase;

export type ExpressionAggregateDefault = T12.ExpressionAggregateDefault;
export type ExpressionAggregateOnWildcard = T12.ExpressionAggregateOnWildcard;
export type ExpressionAggregateSeparator = T12.ExpressionAggregateSeparator;
export type ExpressionAggregate =
  | ExpressionAggregateDefault
  | ExpressionAggregateOnWildcard
  | ExpressionAggregateSeparator;

export type ExpressionOperation = T12.ExpressionPatternOperation;

export type ExpressionPatternOperation = Patch<T12.ExpressionPatternOperation, { args: PatternGroup }>;

export type ExpressionFunctionCall = T12.ExpressionFunctionCall;

export type Expression =
  | ExpressionOperation
  | ExpressionPatternOperation
  | ExpressionFunctionCall
  | ExpressionAggregate
  | TermIri
  | TermVariable
  | TermLiteral
  | TermTriple;

export type PropertyPathChain = T12.PropertyPathChain;
export type PathModified = T12.PathModified;
export type PathNegatedElt = T12.PathNegatedElt;
export type PathAlternativeLimited = T12.PathAlternativeLimited;
export type PathNegated = T12.PathNegated;
// [[88]](https://www.w3.org/TR/sparql11-query/#rPath)
export type Path = T12.Path;
export type PathPure = PropertyPathChain | PathModified | PathNegated;

export type ContextDefinitionPrefix = T12.ContextDefinitionPrefix;
export type ContextDefinitionBase = T12.ContextDefinitionBase;
export type ContextDefinitionVersion = T12.ContextDefinitionVersion;
export type ContextDefinition = T12.ContextDefinition | ContextDefinitionVersion | ContextDefinitionView;

export type Wildcard = T12.Wildcard;
export type TermLiteralStr = T12.TermLiteralStr;
export type TermLiteralLangStr = T12.TermLiteralLangStr;
export type TermLiteralTyped = T12.TermLiteralTyped;
export type TermLiteral = T12.TermLiteral;
export type TermVariable = T12.TermVariable;
export type TermIriFull = T12.TermIriFull;
export type TermIriPrefixed = T12.TermIriPrefixed;
export type TermIri = T12.TermIri;
export type TermBlank = T12.TermBlank;

export type TermTriple = T12.TermTriple;

export type Term = GraphTerm | TermVariable;
export type GraphTerm = TermIri | TermBlank | TermLiteral | TermTriple;
