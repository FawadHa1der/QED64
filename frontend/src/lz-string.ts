// A vendored, dependency-free port of lz-string 1.5.0 (https://github.com/pieroxy/lz-string):
// the four base64-alphabet entry points lean4web's `#codez=` links use
// (docs/EMBEDDING.md §3.1), over the package's own `_compress` / `_decompress`
// core, so a link produced by the npm package decodes here byte for byte
// (tests/unit/lz-string.test.ts pins the bytes). Page-tier code, beside
// `codeFromHash` (page-api.ts): the library (`lib/`) does not read URLs.
//
// One local addition, additive: the decoders take an optional `maxChars`; a
// stream that would decode to more than that yields null before the text is
// built (a short LZW stream can expand quadratically; the page's cap is 2 MiB).
//
// MIT License
//
// Copyright (c) 2013 pieroxy
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

const keyStrBase64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const keyStrUriSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
const baseReverseDic: Record<string, Record<string, number>> = {};

function getBaseValue(alphabet: string, character: string): number {
  let dic = baseReverseDic[alphabet];
  if (!dic) {
    dic = baseReverseDic[alphabet] = {};
    for (let i = 0; i < alphabet.length; i++) dic[alphabet.charAt(i)] = i;
  }
  // A character outside the alphabet (or past the end of the input) reads as
  // 0 bits, as the package's `undefined & position` did.
  return dic[character] ?? 0;
}

/** lean4web's writer (`compressToBase64(code).replace(/=*$/, "")` is its `#codez=` value). Padded to a multiple of 4. */
export function compressToBase64(input: string): string {
  const res = _compress(input, 6, (a) => keyStrBase64.charAt(a));
  switch (res.length % 4) {
    case 1: return res + "===";
    case 2: return res + "==";
    case 3: return res + "=";
    default: return res;
  }
}

/** lean4web's reader. "" and a stream that ends early yield ""; a corrupt stream yields null; over `maxChars` of text yields null. */
export function decompressFromBase64(input: string, maxChars = Infinity): string | null {
  if (input === "") return null;
  return _decompress(input.length, 32, (index) => getBaseValue(keyStrBase64, input.charAt(index)), maxChars);
}

/** The URI-safe alphabet (`+-$` for `+/=`, no padding): lz-string's other URL spelling. */
export function compressToEncodedURIComponent(input: string): string {
  return _compress(input, 6, (a) => keyStrUriSafe.charAt(a));
}

export function decompressFromEncodedURIComponent(input: string, maxChars = Infinity): string | null {
  if (input === "") return null;
  const s = input.replace(/ /g, "+");
  return _decompress(s.length, 32, (index) => getBaseValue(keyStrUriSafe, s.charAt(index)), maxChars);
}

function _compress(uncompressed: string, bitsPerChar: number, getCharFromInt: (a: number) => string): string {
  const dictionary = new Map<string, number>();
  const dictionaryToCreate = new Set<string>();
  let w = "";
  let enlargeIn = 2; // compensates for the first entry, which should not count
  let dictSize = 3;
  let numBits = 2;
  const data: string[] = [];
  let dataVal = 0;
  let dataPosition = 0;

  const writeBit = (bit: number) => {
    dataVal = (dataVal << 1) | bit;
    if (dataPosition === bitsPerChar - 1) {
      dataPosition = 0;
      data.push(getCharFromInt(dataVal));
      dataVal = 0;
    } else dataPosition++;
  };
  const writeBits = (value: number, count: number) => {
    for (let i = 0; i < count; i++) { writeBit(value & 1); value >>= 1; }
  };
  const grow = () => {
    enlargeIn--;
    if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
  };
  /** The code for `w`: a new character is announced as 0 (8-bit) or 1 (16-bit) in `numBits`, then its code. */
  const output = () => {
    if (dictionaryToCreate.has(w)) {
      const code = w.charCodeAt(0);
      if (code < 256) { writeBits(0, numBits); writeBits(code, 8); }
      else { writeBits(1, numBits); writeBits(code, 16); }
      grow();
      dictionaryToCreate.delete(w);
    } else writeBits(dictionary.get(w)!, numBits);
    grow();
  };

  for (let ii = 0; ii < uncompressed.length; ii++) {
    const c = uncompressed.charAt(ii);
    if (!dictionary.has(c)) {
      dictionary.set(c, dictSize++);
      dictionaryToCreate.add(c);
    }
    const wc = w + c;
    if (dictionary.has(wc)) w = wc;
    else {
      output();
      dictionary.set(wc, dictSize++);
      w = c;
    }
  }
  if (w !== "") output();
  writeBits(2, numBits); // the end of the stream
  for (;;) { // flush the last character
    dataVal <<= 1;
    if (dataPosition === bitsPerChar - 1) { data.push(getCharFromInt(dataVal)); break; }
    dataPosition++;
  }
  return data.join("");
}

function _decompress(length: number, resetValue: number, getNextValue: (index: number) => number, maxChars: number): string | null {
  const dictionary: string[] = [];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  const result: string[] = [];
  let size = 0;
  const data = { val: getNextValue(0), position: resetValue, index: 1 };

  const readBits = (count: number): number => {
    let bits = 0;
    const maxpower = Math.pow(2, count);
    let power = 1;
    while (power !== maxpower) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index++);
      }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return bits;
  };

  let c: string;
  switch (readBits(2)) {
    case 0: c = String.fromCharCode(readBits(8)); break;
    case 1: c = String.fromCharCode(readBits(16)); break;
    case 2: return ""; // the end marker first: the empty string
    default: return null; // a prefix no writer emits: corrupt (upstream returns null, "" or throws here; the Worker port answers null)
  }
  dictionary[3] = c;
  let w = c;
  result.push(c);
  size += c.length;
  for (;;) {
    if (data.index > length) return "";
    let code = readBits(numBits);
    switch (code) {
      case 0:
        dictionary[dictSize++] = String.fromCharCode(readBits(8));
        code = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        dictionary[dictSize++] = String.fromCharCode(readBits(16));
        code = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join("");
    }
    if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }

    let entry: string;
    if (dictionary[code] !== undefined) entry = dictionary[code]!;
    else if (code === dictSize) entry = w + w.charAt(0);
    else return null;
    result.push(entry);
    size += entry.length;
    if (size > maxChars) return null;
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
  }
}
