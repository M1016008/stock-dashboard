// The formal EDINET correction target is preserved separately. These two
// predecessor links are based on the correction text and immutable XBRL.
export const CORRECTION_PREDECESSOR_ADJUDICATIONS: Record<string, {
  formalTargetId: string
  predecessorId: string
  predecessorSha256: string
  currentSha256: string
  evidence: string
}> = {
  S100Y1RL: {
    formalTargetId: 'S100Y0JP',
    predecessorId: 'S100Y1GY',
    predecessorSha256: 'f4889a1cb323e58e26688993c90e77c5dd7e83d2fb959cf0bb4c15fe0fda3467',
    currentSha256: 'f4889a1cb323e58e26688993c90e77c5dd7e83d2fb959cf0bb4c15fe0fda3467',
    evidence: 'S100Y1RL correction text identifies the 2026-04-30 correction cover as erroneous; both attached XBRL instances are identical.',
  },
  S100Z26F: {
    formalTargetId: 'S100YZFC',
    predecessorId: 'S100Z1X5',
    predecessorSha256: '30beb3de980870a21493e72dbb827f0de8f1b3c054bce28a030444597e2ca527',
    currentSha256: 'c4c4958b5033d5223fcf21ec30392ca06d1acaf30cfbca1b481c0c64767a8b59',
    evidence: 'S100Z26F correction text changes only the representative name; its full XBRL retains S100Z1X5 corrected holdings.',
  },
}
