# `interface` Writer

[Documentation Index](../README.md)

An abstract interface which when implemented provides an interface to write
bytes from an array buffer to a file/resource asynchronously.

## This interface has

- method [write](#-writep-uint8array-promisenumber)


#### ⚙ write(p: Uint8Array): Promise\<`number`>

> Writes `p.byteLength` bytes from `p` to the underlying data stream. It
> resolves to the number of bytes written from `p` (`0` <= `n` <=
> `p.byteLength`) or reject with the error encountered that caused the
> write to stop early. `write()` must reject with a non-null error if
> would resolve to `n` < `p.byteLength`. `write()` must not modify the
> slice data, even temporarily.
> 
> This function is one of the lowest
> level APIs and most users should not work with this directly, but rather
> use https://jsr.io/@std/io/doc/write-all/~/writeAll writeAll
> instead.
> 
> Implementations should not retain a reference to `p`.



