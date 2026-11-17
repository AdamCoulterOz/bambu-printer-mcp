export async function resolve(specifier,context,next) {
  if(context.parentURL?.endsWith('/dist/index.js') && specifier==='./signing/http-proof.js') return {url:'data:text/javascript,'+encodeURIComponent('export async function handyClientHeaders(){return {"x-bbl-client-name":"fixture"}};export async function createHttpProof(){return {"x-proof":"fixture"}}'),shortCircuit:true};
  return next(specifier,context);
}
