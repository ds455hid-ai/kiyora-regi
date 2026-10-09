// アイコン生成: node scripts/make-icons.mjs  (public/ に PNG と SVG を書き出す)
import { Resvg } from '@resvg/resvg-js'
import { writeFileSync } from 'node:fs'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#B8792E"/>
  <rect x="0" y="360" width="512" height="152" fill="#96601F" opacity="0.35"/>
  <line x1="132" y1="408" x2="380" y2="104" stroke="#F6E7C8" stroke-width="14" stroke-linecap="round"/>
  <g transform="translate(334 152)">
    <circle r="54" fill="#FFF8EA"/><circle r="23" fill="#F3B63F"/>
  </g>
  <g transform="translate(256 252) rotate(-38)">
    <rect x="-52" y="-52" width="104" height="104" rx="22" fill="#FFF3DC" stroke="#E9D2A6" stroke-width="8"/>
    <path d="M-26 -8 Q0 -26 26 -8" stroke="#E2C48E" stroke-width="7" fill="none" stroke-linecap="round"/>
  </g>
  <g transform="translate(184 346) rotate(-38)">
    <polygon points="0,-58 56,40 -56,40" fill="#5B4636" stroke="#3E2E22" stroke-width="6" stroke-linejoin="round"/>
  </g>
</svg>`

const png = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
writeFileSync('public/pwa-192.png', png(192))
writeFileSync('public/pwa-512.png', png(512))
writeFileSync('public/maskable-512.png', png(512))
writeFileSync('public/apple-touch-icon.png', png(180))
writeFileSync('public/favicon.svg', svg)
console.log('icons written')
