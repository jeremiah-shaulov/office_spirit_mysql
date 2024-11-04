# `interface` Seeker

[Documentation Index](../README.md)

An abstract interface which when implemented provides an interface to seek
within an open file/resource asynchronously.

## This interface has

- method [seek](#-seekoffset-number--bigint-whence-seekmode-promisenumber)


#### ⚙ seek(offset: `number` | `bigint`, whence: [SeekMode](../private.enum.SeekMode/README.md)): Promise\<`number`>

> Seek sets the offset for the next `read()` or `write()` to offset,
> interpreted according to `whence`: `Start` means relative to the
> start of the file, `Current` means relative to the current offset,
> and `End` means relative to the end. Seek resolves to the new offset
> relative to the start of the file.
> 
> Seeking to an offset before the start of the file is an error. Seeking to
> any positive offset is legal, but the behavior of subsequent I/O
> operations on the underlying object is implementation-dependent.
> 
> It resolves with the updated offset.



