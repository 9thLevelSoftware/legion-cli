use wasmtime::{Error, Result, component::{ComponentType, Lift, WasmStr}};
use wasmtime::component::__internal::{InstanceType, LiftContext, wasmtime_environ::component::{CanonicalAbiInfo, InterfaceType, StringEncoding}};
use crate::protocol::OUTPUT_BYTES;

pub struct ValidatorString(pub String);

enum Storage<'a> {
    Utf8(&'a [u8]),
    Utf16(&'a [u8]),
    Latin1(&'a [u8]),
}

// This adapter intentionally uses Wasmtime 49.0.2's pinned, doc-hidden lifting
// contract. Re-review against dependency source before any Wasmtime upgrade.
// Safety: ABI layout and type checking are exactly WasmStr's; all guest reads
// below use checked slices, and no guest-memory reference escapes Lift.
unsafe impl ComponentType for ValidatorString {
    type Lower = <WasmStr as ComponentType>::Lower;
    const ABI: CanonicalAbiInfo = <WasmStr as ComponentType>::ABI;
    const MAY_REQUIRE_REALLOC: bool = <WasmStr as ComponentType>::MAY_REQUIRE_REALLOC;

    fn typecheck(ty: &InterfaceType, types: &InstanceType<'_>) -> Result<()> {
        <WasmStr as ComponentType>::typecheck(ty, types)
    }
}

impl ValidatorString {
    fn storage<'a>(cx: &LiftContext<'a>, pointer: usize, length: usize) -> Result<Storage<'a>> {
        let encoding = cx.options().string_encoding;
        let (units, width, alignment) = match encoding {
            StringEncoding::Utf8 => (length, 1usize, 1usize),
            StringEncoding::Utf16 => (length, 2, 2),
            StringEncoding::CompactUtf16 => {
                // Wasmtime 49 uses a 32-bit canonical pointer pair and bit 31
                // to distinguish UTF-16 code units from Latin-1 bytes.
                let tagged = length & (1usize << 31) != 0;
                (length & !(1usize << 31), if tagged { 2 } else { 1 }, 2)
            }
        };
        // Every UTF-16 unit or Latin-1 byte contributes at least one UTF-8
        // byte. UTF-16 storage can be twice the decoded cap, not merely 1 MiB.
        if units > OUTPUT_BYTES { return Err(Error::msg("Validator result exceeds 1 MiB")); }
        if pointer % alignment != 0 { return Err(Error::msg("Validator result pointer is misaligned")); }
        let bytes = units.checked_mul(width).ok_or_else(|| Error::msg("Validator result storage length overflow"))?;
        let end = pointer.checked_add(bytes).ok_or_else(|| Error::msg("Validator result pointer overflow"))?;
        let slice = cx.memory().get(pointer..end).ok_or_else(|| Error::msg("Validator result storage is out of bounds"))?;
        Ok(match encoding {
            StringEncoding::Utf8 => Storage::Utf8(slice),
            StringEncoding::Utf16 => Storage::Utf16(slice),
            StringEncoding::CompactUtf16 if width == 2 => Storage::Utf16(slice),
            StringEncoding::CompactUtf16 => Storage::Latin1(slice),
        })
    }

    fn decode(storage: Storage<'_>) -> Result<Self> {
        fn add_bytes(current: usize, extra: usize) -> Result<usize> {
            current.checked_add(extra).filter(|length| *length <= OUTPUT_BYTES)
                .ok_or_else(|| Error::msg("Decoded validator result exceeds 1 MiB"))
        }
        match storage {
            Storage::Utf8(bytes) => {
                let text = core::str::from_utf8(bytes)?;
                let mut output = String::with_capacity(text.len());
                output.push_str(text);
                Ok(Self(output))
            }
            Storage::Utf16(bytes) => {
                let characters = || core::char::decode_utf16(bytes.chunks_exact(2).map(|unit| u16::from_le_bytes([unit[0], unit[1]])));
                let length = characters().try_fold(0, |length, character| add_bytes(length, character?.len_utf8()))?;
                let mut output = String::with_capacity(length);
                for character in characters() { output.push(character?); }
                Ok(Self(output))
            }
            Storage::Latin1(bytes) => {
                let length = bytes.iter().try_fold(0, |length, byte| add_bytes(length, if *byte < 128 { 1 } else { 2 }))?;
                let mut output = String::with_capacity(length);
                for byte in bytes { output.push(char::from(*byte)); }
                Ok(Self(output))
            }
        }
    }
}

// Safety: both lifting forms retain WasmStr's exact canonical representation
// and delegate its validation/fuel accounting. Owned decoding is completed
// while LiftContext's immutable memory is live, before automatic post-return.
unsafe impl Lift for ValidatorString {
    fn linear_lift_from_flat(cx: &mut LiftContext<'_>, ty: InterfaceType, source: &Self::Lower) -> Result<Self> {
        let pointer = usize::try_from(source[0].get_u32())?;
        let length = usize::try_from(source[1].get_u32())?;
        let storage = Self::storage(cx, pointer, length)?;
        <WasmStr as Lift>::linear_lift_from_flat(cx, ty, source)?;
        Self::decode(storage)
    }

    fn linear_lift_from_memory(cx: &mut LiftContext<'_>, ty: InterfaceType, source: &[u8]) -> Result<Self> {
        let pointer_bytes: [u8; 4] = source.get(..4).ok_or_else(|| Error::msg("Short canonical string pointer"))?.try_into()?;
        let length_bytes: [u8; 4] = source.get(4..8).ok_or_else(|| Error::msg("Short canonical string length"))?.try_into()?;
        let pointer = usize::try_from(u32::from_le_bytes(pointer_bytes))?;
        let length = usize::try_from(u32::from_le_bytes(length_bytes))?;
        let storage = Self::storage(cx, pointer, length)?;
        <WasmStr as Lift>::linear_lift_from_memory(cx, ty, source)?;
        Self::decode(storage)
    }
}
