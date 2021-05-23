export type DatasetInfo = {
  field_ids: [number, string][];
  schema: [
    {
      name: "filename";
      options: {
        indexing: null;
        stored: true;
      };
      type: "text";
    },
    {
      name: "text";
      options: {
        indexing: {
          record: "freq";
          tokenizer: "en_stem";
        };
        stored: false;
      };
      type: "text";
    },
    {
      name: "authors";
      options: {
        indexing: {
          record: "position";
          tokenizer: "en_stem";
        };
        stored: true;
      };
      type: "text";
    },
    {
      name: "title";
      options: {
        indexing: {
          record: "position";
          tokenizer: "en_stem";
        };
        stored: true;
      };
      type: "text";
    }
  ];
  space_usage: {
    segments: [
      {
        deletes: 0;
        fast_fields: {
          fields: {};
          total: 0;
        };
        fieldnorms: {
          fields: Record<number, {num_bytes: number}?>
          total: number;
        };
        num_docs: number;
        positions: {
          fields: Record<number, {num_bytes: number}?>;
          total: number;
        };
        positions_idx: {
          fields: Record<number, {num_bytes: number}?>;
          total: number;
        };
        postings: {
          fields: Record<number, {num_bytes: number}?>;
          
          total: number;
        };
        store: {
          data: number;
          offsets: number;
        };
        termdict: {
          fields: Record<number, {num_bytes: number}?>
          total: number;
        };
        total: number;
      }
    ];
    total: number;
  };
};
export type Doc = {
  score: number;
  doc: { authors: string; title: string; filename: string };
};
export type Stat = {
  reason: string;
  fetchedAmount: number;
  requestCount: number;
  cachedReadAmount: number;
  totalReadCount: number;
};
