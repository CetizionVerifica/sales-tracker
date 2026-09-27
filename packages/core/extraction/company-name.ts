/**
 * Company names as printed vary in case, punctuation and legal suffix ("Pvt. Ltd." vs
 * "Private Limited"). Both sides are reduced to their distinctive words before comparing.
 * M7 uses it for the quotation review warning; M10 reuses it for invoices.
 */
const SUFFIXES = [
  ['private', 'limited'],
  ['pvt', 'ltd'],
  ['pvt', 'limited'],
  ['private', 'ltd'],
  ['public', 'limited'],
  ['limited'],
  ['ltd'],
  ['llp'],
  ['llc'],
  ['inc'],
  ['incorporated'],
  ['corp'],
  ['corporation'],
  ['co'],
  ['company'],
  ['plc'],
  ['gmbh'],
] as const;

export function normaliseCompanyName(name: string): string {
  const words = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words[0] === 'the') words.shift();
  // Drop a trailing legal suffix (longest first); "M/s" prefixes are common on Indian papers.
  if (words[0] === 'm' && words[1] === 's') words.splice(0, 2);
  for (const suffix of SUFFIXES) {
    const tail = words.slice(-suffix.length);
    if (words.length > suffix.length && suffix.every((word, i) => tail[i] === word)) {
      words.splice(-suffix.length);
      break;
    }
  }
  return words.join(' ');
}

/** Whether a name from a document refers to the client on the record. */
export function sameCompany(a: string, b: string): boolean {
  const left = normaliseCompanyName(a);
  return left !== '' && left === normaliseCompanyName(b);
}
