# `interface` Reader

[Documentation Index](../README.md)

An abstract interface which when implemented provides an interface to read
bytes into an array buffer asynchronously.

## This interface has

- method [read](#-readp-uint8array-promisenumber)


#### ⚙ read(p: Uint8Array): Promise\<`number`>

> Reads up to `p.byteLength` bytes into `p`. It resolves to the number of
> bytes read (`0` < `n` <= `p.byteLength`) and rejects if any error
> encountered. Even if `read()` resolves to `n` < `p.byteLength`, it may
> use all of `p` as scratch space during the call. If some data is
> available but not `p.byteLength` bytes, `read()` conventionally resolves
> to what is available instead of waiting for more.
> 
> When `read()` encounters end-of-file condition, it resolves to EOF
> (`null`).
> 
> When `read()` encounters an error, it rejects with an error.
> 
> Callers should always process the `n` > `0` bytes returned before
> considering the EOF (`null`). Doing so correctly handles I/O errors that
> happen after reading some bytes and also both of the allowed EOF
> behaviors.
> 
> Implementations should not retain a reference to `p`.
> 
> Use
> https://jsr.io/@std/io/doc/iterate-reader/~/iterateReader iterateReader
> to turn > `interface` Reader<br>
>> {<br>
>> &nbsp; &nbsp; ⚙ read(p: Uint8Array): Promise\<`number`><br>
>> }
> 
>  into an AsyncIterator.



