const fs = require('fs');
const buf = fs.readFileSync('assets/flutter_assets/kernel_blob.bin');

const offset = 58821658;
const slice = buf.slice(offset - 600, offset + 600);
let cleaned = '';
for (let i = 0; i < slice.length; i++) {
  const b = slice[i];
  if (b >= 32 && b <= 126) cleaned += String.fromCharCode(b);
  else if (b === 10 || b === 13) cleaned += '\n';
  else cleaned += '.';
}
console.log(cleaned);
