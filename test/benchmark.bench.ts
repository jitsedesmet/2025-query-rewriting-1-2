import { QueryEngine } from '@comunica/query-sparql-file';
import type * as RDF from '@rdfjs/types';
import * as arrayifyStreamNS from 'arrayify-stream';
import { Store } from 'n3';
import { beforeAll, bench, describe } from 'vitest';
import { transformFilterFalse } from '../lib/transformations/filterFalse.js';
import { nullifyJoinOverIncompatibleBounds } from '../lib/transformations/nullifyJoinOverIncompatibleBounds.js';
import { operationTransform, queryTransform } from '../lib/transformBgp.js';
import { transformContextFromConstructs } from '../lib/transformContext.js';
import {
  nonSingletonTripleConstruct,
  nonTripleTermConstruct,
  singletonPropertyConstruct,
  tripleTermConstruct,
} from './queries.js';

// Crazy workaround to support both CJS and ESM
const arrayifyStream =
  (<any> arrayifyStreamNS).default ?? arrayifyStreamNS;

const engine = new QueryEngine();

const standardTransformations = <const>[
  operationTransform,
  transformFilterFalse,
  nullifyJoinOverIncompatibleBounds,
  transformFilterFalse,
];

const rdfMappers = [ tripleTermConstruct, nonTripleTermConstruct ];
const spMappers = [ singletonPropertyConstruct, nonSingletonTripleConstruct ];

// Contexts are created synchronously and shared across describe blocks.
const rdfMapperContext = transformContextFromConstructs(rdfMappers);
const spMapperContext = transformContextFromConstructs(spMappers);

// ── Helper ────────────────────────────────────────────────────────────────────

type MapperContext = ReturnType<typeof transformContextFromConstructs>;

async function loadStore(path: string): Promise<Store> {
  const quads: RDF.Quad[] = await arrayifyStream(
    await engine.queryQuads('CONSTRUCT WHERE { ?s ?p ?o }', { sources: [ path ]}),
  );
  return new Store(quads);
}

async function runRewrittenQuery(store: Store, context: MapperContext, query: string): Promise<void> {
  const rewritten = queryTransform(context, query, [ ...standardTransformations ]);
  await arrayifyStream(await engine.queryBindings(rewritten, { sources: [ store ]}));
}

// ── RDF interop reification – context creation ────────────────────────────────

describe('context creation', () => {
  bench('transformContextFromConstructs – rdf interop mappers', () => {
    transformContextFromConstructs(rdfMappers);
  });

  bench('transformContextFromConstructs – singleton property mappers', () => {
    transformContextFromConstructs(spMappers);
  });
});

// ── RDF interop reification – query transform only ────────────────────────────

describe('query rewriting only – rdf interop', () => {
  const simpleQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }`;

  const annotatedQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX : <ex://>
    SELECT ?s ?p ?o ?agent WHERE {
      ?t rdf:reifies <<( ?s ?p ?o )>> .
      OPTIONAL { ?t :statedBy ?agent }
    }`;

  const filteredQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX : <ex://>
    SELECT ?s ?p ?o WHERE {
      ?t rdf:reifies <<( ?s ?p ?o )>> .
      ?t :statedBy :wikipedia .
    }`;

  bench('simple triple-term SELECT', () => {
    queryTransform(rdfMapperContext, simpleQuery, [ ...standardTransformations ]);
  });

  bench('triple-term SELECT with OPTIONAL annotation (StarBench S6)', () => {
    queryTransform(rdfMapperContext, annotatedQuery, [ ...standardTransformations ]);
  });

  bench('triple-term SELECT with annotation filter (StarBench S2)', () => {
    queryTransform(rdfMapperContext, filteredQuery, [ ...standardTransformations ]);
  });
});

// ── Singleton property – query transform only ─────────────────────────────────

describe('query rewriting only – singleton property', () => {
  const employeeQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX : <ex://>
    SELECT ?employee ?role WHERE {
      ?prop rdf:reifies <<( ?employee :worksFor :acme )>> .
      ?prop :role ?role .
    }`;

  bench('employee + role SELECT', () => {
    queryTransform(spMapperContext, employeeQuery, [ ...standardTransformations ]);
  });
});

// ── End-to-end (rewrite + execute) ────────────────────────────────────────────

describe('end-to-end – rdf interop reification', () => {
  let store: Store;

  beforeAll(async() => {
    store = await loadStore('./test/statics/multipleRdfReifiedTriples.ttl');
  });

  bench('s1 – all statements about alice', async() => {
    await runRewrittenQuery(
      store,
      rdfMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?p ?o WHERE { ?t rdf:reifies <<( :alice ?p ?o )>> }`,
    );
  });

  bench('s2 – statements from wikipedia', async() => {
    await runRewrittenQuery(
      store,
      rdfMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> . ?t :statedBy :wikipedia . }`,
    );
  });

  bench('s6 – OPTIONAL annotation for all statements', async() => {
    await runRewrittenQuery(
      store,
      rdfMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?s ?p ?o ?agent WHERE {
         ?t rdf:reifies <<( ?s ?p ?o )>> .
         OPTIONAL { ?t :statedBy ?agent }
       }`,
    );
  });
});

// ── End-to-end – StarBench dataset ───────────────────────────────────────────

describe('end-to-end – StarBench dataset (rdf interop)', () => {
  const PREFIX = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
     PREFIX sb: <http://starbench.example.org/>
     PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;
  let store: Store;

  beforeAll(async() => {
    store = await loadStore('./test/statics/starbenchData.ttl');
  });

  bench('s1 – subject filter', async() => {
    await runRewrittenQuery(
      store,
      rdfMapperContext,
      `${PREFIX} SELECT ?p ?o WHERE { ?t rdf:reifies <<( sb:alice ?p ?o )>> }`,
    );
  });

  bench('s2 – source filter', async() => {
    await runRewrittenQuery(
      store,
      rdfMapperContext,
      `${PREFIX} SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> . ?t sb:source sb:paper1 . }`,
    );
  });

  bench('s3 – confidence threshold FILTER', async() => {
    await runRewrittenQuery(
      store,
      rdfMapperContext,
      `${PREFIX} SELECT ?s ?p ?o ?c WHERE {
         ?t rdf:reifies <<( ?s ?p ?o )>> .
         ?t sb:confidence ?c .
         FILTER(?c > "0.8"^^xsd:decimal)
       }`,
    );
  });

  bench('s6 – OPTIONAL date annotation', async() => {
    await runRewrittenQuery(
      store,
      rdfMapperContext,
      `${PREFIX} SELECT ?s ?p ?o ?date WHERE {
         ?t rdf:reifies <<( ?s ?p ?o )>> .
         OPTIONAL { ?t sb:date ?date }
       }`,
    );
  });
});

// ── End-to-end – singleton property ──────────────────────────────────────────

describe('end-to-end – singleton property reification', () => {
  let store: Store;

  beforeAll(async() => {
    store = await loadStore('./test/statics/singletonPropertyData.ttl');
  });

  bench('employees with role', async() => {
    await runRewrittenQuery(
      store,
      spMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?employee ?role WHERE {
         ?prop rdf:reifies <<( ?employee :worksFor :acme )>> .
         ?prop :role ?role .
       }`,
    );
  });

  bench('employees with OPTIONAL start date', async() => {
    await runRewrittenQuery(
      store,
      spMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?employee ?o ?date WHERE {
         ?prop rdf:reifies <<( ?employee :worksFor ?o )>> .
         OPTIONAL { ?prop :startDate ?date }
       }`,
    );
  });
});


// ── RDF interop reification – context creation ────────────────────────────────

describe('context creation', () => {
  bench('transformContextFromConstructs – rdf interop mappers', () => {
    transformContextFromConstructs(rdfMappers);
  });

  bench('transformContextFromConstructs – singleton property mappers', () => {
    transformContextFromConstructs(spMappers);
  });
});

// ── RDF interop reification – query transform only ────────────────────────────

describe('query rewriting only – rdf interop', () => {
  const simpleQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> }`;

  const annotatedQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX : <ex://>
    SELECT ?s ?p ?o ?agent WHERE {
      ?t rdf:reifies <<( ?s ?p ?o )>> .
      OPTIONAL { ?t :statedBy ?agent }
    }`;

  const filteredQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX : <ex://>
    SELECT ?s ?p ?o WHERE {
      ?t rdf:reifies <<( ?s ?p ?o )>> .
      ?t :statedBy :wikipedia .
    }`;

  bench('simple triple-term SELECT', () => {
    queryTransform(rdfMapperContext, simpleQuery, [ ...standardTransformations ]);
  });

  bench('triple-term SELECT with OPTIONAL annotation (StarBench S6)', () => {
    queryTransform(rdfMapperContext, annotatedQuery, [ ...standardTransformations ]);
  });

  bench('triple-term SELECT with annotation filter (StarBench S2)', () => {
    queryTransform(rdfMapperContext, filteredQuery, [ ...standardTransformations ]);
  });
});

// ── Singleton property – query transform only ─────────────────────────────────

describe('query rewriting only – singleton property', () => {
  const employeeQuery = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX : <ex://>
    SELECT ?employee ?role WHERE {
      ?prop rdf:reifies <<( ?employee :worksFor :acme )>> .
      ?prop :role ?role .
    }`;

  bench('employee + role SELECT', () => {
    queryTransform(spMapperContext, employeeQuery, [ ...standardTransformations ]);
  });
});

// ── End-to-end (rewrite + execute) ────────────────────────────────────────────

describe('end-to-end – rdf interop reification', () => {
  bench('s1 – all statements about alice', async() => {
    await runRewrittenQuery(
      storeMultipleRdf,
      rdfMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?p ?o WHERE { ?t rdf:reifies <<( :alice ?p ?o )>> }`,
    );
  });

  bench('s2 – statements from wikipedia', async() => {
    await runRewrittenQuery(
      storeMultipleRdf,
      rdfMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> . ?t :statedBy :wikipedia . }`,
    );
  });

  bench('s6 – OPTIONAL annotation for all statements', async() => {
    await runRewrittenQuery(
      storeMultipleRdf,
      rdfMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?s ?p ?o ?agent WHERE {
         ?t rdf:reifies <<( ?s ?p ?o )>> .
         OPTIONAL { ?t :statedBy ?agent }
       }`,
    );
  });
});

// ── End-to-end – StarBench dataset ───────────────────────────────────────────

describe('end-to-end – StarBench dataset (rdf interop)', () => {
  const PREFIX = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
     PREFIX sb: <http://starbench.example.org/>
     PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;

  bench('s1 – subject filter', async() => {
    await runRewrittenQuery(
      storeStarbench,
      rdfMapperContext,
      `${PREFIX} SELECT ?p ?o WHERE { ?t rdf:reifies <<( sb:alice ?p ?o )>> }`,
    );
  });

  bench('s2 – source filter', async() => {
    await runRewrittenQuery(
      storeStarbench,
      rdfMapperContext,
      `${PREFIX} SELECT ?s ?p ?o WHERE { ?t rdf:reifies <<( ?s ?p ?o )>> . ?t sb:source sb:paper1 . }`,
    );
  });

  bench('s3 – confidence threshold FILTER', async() => {
    await runRewrittenQuery(
      storeStarbench,
      rdfMapperContext,
      `${PREFIX} SELECT ?s ?p ?o ?c WHERE {
         ?t rdf:reifies <<( ?s ?p ?o )>> .
         ?t sb:confidence ?c .
         FILTER(?c > "0.8"^^xsd:decimal)
       }`,
    );
  });

  bench('s6 – OPTIONAL date annotation', async() => {
    await runRewrittenQuery(
      storeStarbench,
      rdfMapperContext,
      `${PREFIX} SELECT ?s ?p ?o ?date WHERE {
         ?t rdf:reifies <<( ?s ?p ?o )>> .
         OPTIONAL { ?t sb:date ?date }
       }`,
    );
  });
});

// ── End-to-end – singleton property ──────────────────────────────────────────

describe('end-to-end – singleton property reification', () => {
  bench('employees with role', async() => {
    await runRewrittenQuery(
      storeSingletonProperty,
      spMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?employee ?role WHERE {
         ?prop rdf:reifies <<( ?employee :worksFor :acme )>> .
         ?prop :role ?role .
       }`,
    );
  });

  bench('employees with OPTIONAL start date', async() => {
    await runRewrittenQuery(
      storeSingletonProperty,
      spMapperContext,
      `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
       PREFIX : <ex://>
       SELECT ?employee ?o ?date WHERE {
         ?prop rdf:reifies <<( ?employee :worksFor ?o )>> .
         OPTIONAL { ?prop :startDate ?date }
       }`,
    );
  });
});
