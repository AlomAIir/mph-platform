/* MPH.illus: ask the AI for scene specs (shots, storyboard frames, production covers), save them, and draw them.
   Drawing is instant (MPH.sketch); the AI call takes a few seconds per batch of shots. */
(function () {
  const BATCH = 8, PARALLEL = 2;

  async function run(ctx, table, key, ids, onProgress) {
    const pid = ctx.production.id;
    const batches = [];
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
    const specs = {};
    let next = 0, done = 0;
    const worker = async () => {
      while (next < batches.length) {
        const b = batches[next++];
        const out = await ctx.api.ai('illustrate', { production_id: pid, [key]: b });
        for (const it of out.items || []) {
          if (!it || !it.id || !it.spec) continue;
          specs[it.id] = it.spec;
          ctx.api.must(await ctx.sb.from(table).update({ illustration: it.spec }).eq('id', it.id));
        }
        done += b.length;
        if (onProgress) onProgress(done, ids.length, specs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
    return specs;
  }

  MPH.illus = {
    /* illustrate shots by id; returns { shotId: spec } */
    shots: (ctx, ids, onProgress) => run(ctx, 'shots', 'shot_ids', ids, onProgress),
    /* illustrate storyboard frames by id */
    frames: (ctx, ids, onProgress) => run(ctx, 'storyboard_frames', 'frame_ids', ids, onProgress),
    /* header image for a production, from its title and description */
    cover: async (ctx, productionId) => {
      const out = await ctx.api.ai('cover', { production_id: productionId });
      if (out && out.spec) ctx.api.must(await ctx.sb.from('productions').update({ cover: out.spec }).eq('id', productionId));
      return out && out.spec;
    },
    /* draw a spec (or a quiet placeholder when there is none yet) */
    draw: (spec, opts) => spec ? MPH.sketch(spec, opts) : '',
  };
})();
