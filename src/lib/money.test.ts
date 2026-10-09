import { describe, expect, it } from 'vitest'
import { toCsv } from './csv'
import { errorMessage, AppError } from './errors'
import { orderNo, yen, signedYen } from './format'
import { backspace, cartTotal, changeOf, denomsPayload, denomsTotal, pressDigit } from './money'

describe('金額計算', () => {
  it('合計・お釣り・不足', () => {
    expect(cartTotal([{ price: 500, qty: 3 }, { price: 200, qty: 2 }])).toBe(1900)
    expect(cartTotal([])).toBe(0)
    expect(changeOf(1900, 2000)).toBe(100)
    expect(changeOf(1900, 1900)).toBe(0)
    expect(changeOf(1900, 1000)).toBe(-900)
  })

  it('金種の合計とRPC用ペイロード(0枚は除外)', () => {
    const counts = { 10000: 1, 1000: 5, 500: 0, 100: 3 }
    expect(denomsTotal(counts)).toBe(10000 + 5000 + 300)
    expect(denomsPayload(counts)).toEqual({ '10000': 1, '1000': 5, '100': 3 })
    expect(denomsTotal({})).toBe(0)
  })

  it('テンキー入力: 先頭ゼロ・00・桁数制限・削除', () => {
    expect(pressDigit('0', '5')).toBe('5')
    expect(pressDigit('0', '00')).toBe('0')
    expect(pressDigit('5', '00')).toBe('500')
    expect(pressDigit('1234567', '8')).toBe('1234567')
    expect(backspace('150')).toBe('15')
    expect(backspace('5')).toBe('0')
    expect(backspace('0')).toBe('0')
  })
})

describe('表示形式', () => {
  it('円・符号付き・注文番号', () => {
    expect(yen(1500)).toBe('¥1,500')
    expect(yen(-300)).toBe('-¥300')
    expect(signedYen(300)).toBe('+¥300')
    expect(signedYen(-300)).toBe('-¥300')
    expect(signedYen(0)).toBe('±¥0')
    expect(orderNo(1)).toBe('001')
    expect(orderNo(42)).toBe('042')
    expect(orderNo(1234)).toBe('1234')
  })
})

describe('CSV', () => {
  it('BOM付き・CRLF・カンマ/改行/引用符のエスケープ', () => {
    const csv = toCsv(['a', 'b'], [['x,y', 'He said "hi"'], ['line\nbreak', 5], [null, undefined]])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toBe('﻿a,b\r\n"x,y","He said ""hi"""\r\n"line\nbreak",5\r\n,\r\n')
  })
})

describe('エラーメッセージ', () => {
  it('DBのエラーコードを日本語にする', () => {
    expect(errorMessage(new AppError('no_open_day'))).toContain('営業が開始されていません')
    expect(errorMessage(new AppError('product_sold_out', 'ビール'))).toBe('「ビール」は売り切れです')
    expect(errorMessage(new AppError('insufficient_received', '1500'))).toContain('¥1,500')
    expect(errorMessage(new AppError('unserved_orders', '3'))).toBe('未提供の注文が3件あります')
    expect(errorMessage(new AppError('something_new'))).toContain('something_new')
  })
})
