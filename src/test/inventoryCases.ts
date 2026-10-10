/**
 * Batch 38: weight-estimate cases shared by the unit test (the screens'
 * copy of the rule) and the e2e test (the database's copy), so both are
 * held to the same answers.
 */
export const WEIGHT_CASES: readonly { text: string; grams: number | null }[] = [
  { text: 'CeraVe Foaming Cleanser Eco-Recharge Refill 473mL', grams: 544 },
  { text: '10 ml', grams: 12 },
  { text: 'La Roche-Posay Cicaplast Lip Barrier Balm 7.5ml', grams: 9 },
  { text: '236 ml', grams: 271 },
  { text: 'Sukin Shampoo 1 L', grams: 1150 },
  { text: 'Body Wash 1.5 litre', grams: 1725 },
  { text: 'Neutrogena Hydro Boost Water Gel 50g', grams: 55 },
  { text: 'Blistex Ultra Lip Balm SPF 50+ 4.25gm', grams: 5 },
  { text: 'Adaferin Gel 15 gm (Galderma)', grams: 17 },
  { text: 'Sudocrem 125 grams', grams: 138 },
  { text: 'Rice 1 kg', grams: 1100 },
  { text: 'Lotion 8 fl oz', grams: 272 },
  { text: 'Lotion 8 fl. oz', grams: 272 },
  { text: 'Cream 3.4 oz', grams: 106 },
  { text: 'OMI Sunscreen SPF 50+ PA++++ 30g', grams: 33 },
  { text: 'Beauty of Joseon Relief Sun Aqua-fresh : Rice +B5 50ml', grams: 58 },
  { text: 'Kirkland Minoxidil 5%', grams: null },
  { text: 'ZGTS Derma Roller 1.00mm (Titanium Derma Roller)', grams: null },
  { text: 'Blackmores Fish Oil 1000 | 400 Capsules', grams: null },
  { text: 'Cosrx Acne Pimple Master Patch 24\'s Pack', grams: null },
  { text: 'Oral B Toothbrush SensitiveX Gentle Clean 3 Pack', grams: null },
  { text: 'The Ordinary Natural Moisturizing Factors + HA (Normal to Oily)', grams: null },
  { text: '100 Lotion', grams: null },
  { text: '', grams: null },
];
