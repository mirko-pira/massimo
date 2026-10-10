import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { equal, ok } from 'node:assert'
import { after, test } from 'node:test'
import { join } from 'node:path'
import { moveToTmpdir } from './helper.js'

const openAPIfile = join(import.meta.dirname, 'fixtures', 'path-map-openapi.json')
const env = { ...process.env, NODE_V8_COVERAGE: undefined }

function findTSCPath () {
  const tscPath = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsc')
  return existsSync(tscPath) ? tscPath : join(import.meta.dirname, '../../..', 'node_modules', '.bin', 'tsc')
}

const expectedPathMap = `export interface MoviesPaths {
  '/movies': {
    'get': { 'request': GetMoviesRequest; 'responses': GetMoviesResponses };
    'post': { 'request': CreateMovieRequest; 'responses': CreateMovieResponses };
  }
  '/movies/{id}': {
    'get': { 'request': GetMoviesIdRequest; 'responses': GetMoviesIdResponses };
    'delete': { 'request': DeleteMovieRequest; 'responses': DeleteMovieResponses };
  }
  '/accounts/{accountId}/folders': {
    'post': { 'request': CreateFolderRequest; 'responses': CreateFolderResponses };
  }
  '/folders': {
    'post': { 'request': PostCreateFolderRequest; 'responses': PostCreateFolderResponses };
  }
}`

// Type-level assertions on the generated declarations: each entry of the map
// must be exactly the type the client method uses, the lookup aliases must
// resolve every entry for a generic path and method, and an unknown path must
// not resolve.
const typeCheck = (from, clientType) => `
import type * as T from '${from}'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false
type Method<K extends keyof T.${clientType}> = T.${clientType}[K] extends (req: infer Req) => Promise<infer Res> ? { request: Req; responses: Res } : never

export const checks: true[] = [
  {} as Equal<T.MoviesPaths['/movies']['get'], Method<'getMovies'>>,
  {} as Equal<T.MoviesPaths['/movies']['post'], Method<'createMovie'>>,
  {} as Equal<T.MoviesPaths['/movies/{id}']['get'], Method<'getMoviesId'>>,
  {} as Equal<T.MoviesPaths['/movies/{id}']['delete'], Method<'deleteMovie'>>,
  {} as Equal<T.MoviesPaths['/accounts/{accountId}/folders']['post'], Method<'createFolder'>>,
  {} as Equal<T.MoviesPaths['/folders']['post'], Method<'postCreateFolder'>>,
  {} as Equal<T.MoviesPaths['/movies/{id}']['get']['request'], T.GetMoviesIdRequest>,
  {} as Equal<T.MoviesPaths['/folders']['post']['responses'], T.PostCreateFolderResponses>,
  {} as Equal<T.MoviesPathRequest<'/folders', 'post'>, T.PostCreateFolderRequest>,
  {} as Equal<T.MoviesPathResponses<'/movies/{id}', 'get'>, T.GetMoviesIdResponses>
]

// Every entry, looked up through the aliases, is the type its client method uses
type IsNever<X> = [X] extends [never] ? true : false
type Resolved<P extends keyof T.MoviesPaths, M extends keyof T.MoviesPaths[P]> =
  IsNever<T.MoviesPathRequest<P, M>> extends true ? false
    : IsNever<T.MoviesPathResponses<P, M>> extends true ? false
      : T.MoviesPaths[P][M] extends { request: T.MoviesPathRequest<P, M>; responses: T.MoviesPathResponses<P, M> } ? true : false
type AllResolved = { [P in keyof T.MoviesPaths]: { [M in keyof T.MoviesPaths[P]]: Resolved<P, M> }[keyof T.MoviesPaths[P]] }[keyof T.MoviesPaths]
export const allResolved: Equal<AllResolved, true> = true

// A caller generic over path and method
export declare function call<P extends keyof T.MoviesPaths, M extends keyof T.MoviesPaths[P]> (path: P, method: M, req: T.MoviesPathRequest<P, M>): Promise<T.MoviesPathResponses<P, M>>

// @ts-expect-error a path that is not in the specification
export type Missing = T.MoviesPaths['/series']
// @ts-expect-error a method that the path does not have
export type MissingMethod = T.MoviesPaths['/folders']['get']
`

async function typecheck (dir, source, lib) {
  await writeFile(join(dir, 'check.ts'), source)
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      lib,
      strict: true,
      noEmit: true,
      // the declaration file itself is checked, not only its use from check.ts
      skipLibCheck: false,
      types: []
    },
    files: ['check.ts']
  }, null, 2))
  await execa(findTSCPath(), ['-p', join(dir, 'tsconfig.json')], { env })
}

test('--named-schemas declares a path map that compiles and points at the operation types', async () => {
  const dir = await moveToTmpdir(after)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  await execa('node', [join(import.meta.dirname, '..', 'index.js'), openAPIfile, '--name', 'movies', '--types-only', '--named-schemas'])
  const data = await readFile(join(dir, 'movies', 'movies.d.ts'), 'utf-8')

  ok(data.includes(expectedPathMap))
  // the operation without operationId uses the id generated from its path
  ok(data.includes('getMoviesId(req: GetMoviesIdRequest): Promise<GetMoviesIdResponses>;'))
  // the second `createFolder` is renamed, and the map follows the rename
  ok(data.includes('postCreateFolder(req: PostCreateFolderRequest): Promise<PostCreateFolderResponses>;'))
  // a component schema cannot take the name of the path map
  ok(data.includes('export type MoviesPathsSchema = string'))
  equal(data.match(/export interface MoviesPaths\b/g).length, 1)
  ok(data.includes("export type MoviesPathRequest<P extends keyof MoviesPaths, M extends keyof MoviesPaths[P]> = MoviesPaths[P][M] extends { 'request': infer R } ? R : never"))
  ok(data.includes("export type MoviesPathResponses<P extends keyof MoviesPaths, M extends keyof MoviesPaths[P]> = MoviesPaths[P][M] extends { 'responses': infer R } ? R : never"))
  // nor the name of a lookup alias
  ok(data.includes('export type MoviesPathRequestSchema = number'))

  await typecheck(dir, typeCheck('./movies/movies.js', 'Movies'), ['es2022'])
})

test('--named-schemas declares the same path map with --frontend', async () => {
  const dir = await moveToTmpdir(after)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  await execa('node', [join(import.meta.dirname, '..', 'index.js'), openAPIfile, '--name', 'movies', '--frontend', '--language', 'ts', '--named-schemas'])
  const data = await readFile(join(dir, 'movies', 'movies-types.d.ts'), 'utf-8')

  ok(data.includes(expectedPathMap))
  ok(data.includes('export type MoviesPathsSchema = string'))

  await typecheck(dir, typeCheck('./movies/movies-types.js', 'Movies'), ['es2022', 'dom'])
})

test('--named-schemas suffixes a lookup alias whose name an operation type already has', async () => {
  const dir = await moveToTmpdir(after)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  const file = join(dir, 'alias-collision.json')
  await writeFile(file, JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Alias collision', version: '1.0.0' },
    paths: { '/movies-path': { get: { operationId: 'moviesPath', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } } } } }
  }))
  await execa('node', [join(import.meta.dirname, '..', 'index.js'), file, '--name', 'movies', '--types-only', '--named-schemas'])
  const data = await readFile(join(dir, 'movies', 'movies.d.ts'), 'utf-8')

  ok(data.includes('moviesPath(req: MoviesPathRequest): Promise<MoviesPathResponses>;'))
  ok(data.includes('export type MoviesPathRequest2<'))
  ok(data.includes('export type MoviesPathResponses2<'))

  await typecheck(dir, `
import type * as T from './movies/movies.js'
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false
export const checks: true[] = [
  {} as Equal<T.MoviesPathRequest2<'/movies-path', 'get'>, T.MoviesPathRequest>,
  {} as Equal<T.MoviesPathResponses2<'/movies-path', 'get'>, T.MoviesPathResponses>
]
`, ['es2022'])
})

for (const [args, file] of [[['--types-only'], 'movies.d.ts'], [['--frontend', '--language', 'ts'], 'movies-types.d.ts']]) {
  test(`without --named-schemas no path map is declared (${args.join(' ')})`, async () => {
    const dir = await moveToTmpdir(after)
    await execa('node', [join(import.meta.dirname, '..', 'index.js'), openAPIfile, '--name', 'movies', ...args])
    const data = await readFile(join(dir, 'movies', file), 'utf-8')

    equal(data.includes('MoviesPaths'), false)
  })
}
