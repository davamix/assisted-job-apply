// Classify a file-upload field's label as asking for a CV, a Résumé, or neither.
//
// Used by the apply adapters to decide which document to attach. The distinction
// matters because some employers ask for a shorter US-style "Résumé" rather than
// the full "CV" — see scripts/README.md and the CV-vs-Résumé flow.
//
// CV wins when a label mentions both (e.g. "Resume / CV"): a full CV satisfies a
// combined ask, so we only trigger on-demand résumé authoring when the field asks
// *specifically* for a Résumé.
//
//   classifyDocField('Resume*')          -> 'resume'
//   classifyDocField('CV')               -> 'cv'
//   classifyDocField('Curriculum Vitae') -> 'cv'
//   classifyDocField('Currículum*')      -> 'cv'   (Spanish; the standard word for a CV)
//   classifyDocField('Currículo')        -> 'cv'   (Portuguese/Spanish variant)
//   classifyDocField('Resume / CV')      -> 'cv'
//   classifyDocField('Portfolio')        -> 'unknown'

function classifyDocField(labelText) {
  const s = String(labelText == null ? '' : labelText);
  // CV wins when a label names both (e.g. "Resume / CV") — a full CV satisfies a combined
  // ask. "Currículum" / "Currículo" (ES/PT) is the everyday word for a CV, so it counts too.
  if (/\b(cv|curriculum\s+vitae)\b/i.test(s) || /curr[ií]cul(?:um|o)/i.test(s)) return 'cv';
  if (/\br[eé]sum[eé]/i.test(s)) return 'resume';
  return 'unknown';
}

module.exports = { classifyDocField };
