/**
 * CSV output for the export tools.
 *
 * Every value is quoted, including numbers, because a spreadsheet reading an unquoted
 * leading zero will silently turn a handle like `007fan` into the number 7. Escaping is the
 * minimal RFC 4180 rule — double any quote, then wrap.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const cell = value => {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * Renders rows as CSV.
 *
 * `columns` is an ordered list of `[header, value]` pairs so the file's column order is
 * explicit and stable across runs — a spreadsheet that reorders columns between exports is
 * one the user cannot diff.
 */
export const toCsv = (rows, columns) => {
  const header = columns.map(([name]) => cell(name)).join(',')
  const body = rows.map(row => columns.map(([, get]) => cell(get(row))).join(',')).join('\n')
  return `${header}\n${body}\n`
}

/** Writes the CSV, creating the destination folder if it does not exist. */
export const writeCsv = (path, rows, columns) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, toCsv(rows, columns), 'utf8')
  return path
}

/** Folder every export lands in, so nothing is scattered across the working directory. */
export const exportDir = () =>
  process.env.IG_MCP_EXPORT_DIR ??
  `${process.env.USERPROFILE ?? '.'}\\Documents\\INSSIST-exports`
