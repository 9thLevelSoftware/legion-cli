#![no_std]

extern crate alloc;

use alloc::{string::String, vec::Vec};
use core::fmt;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

#[derive(Clone, Copy)]
struct Seed {
    depth: usize,
    max_depth: usize,
    safe_integers: bool,
}

impl<'de> DeserializeSeed<'de> for Seed {
    type Value = Value;

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.depth > self.max_depth {
            return Err(de::Error::custom("JSON nesting limit exceeded"));
        }
        deserializer.deserialize_any(self)
    }
}

impl Seed {
    fn number<E: de::Error>(self, n: f64) -> Result<Value, E> {
        if !n.is_finite() || (self.safe_integers && n % 1.0 == 0.0 && (n > 9_007_199_254_740_991.0 || n < -9_007_199_254_740_991.0)) {
            return Err(E::custom("Nonfinite number or unsafe integral value"));
        }
        Number::from_f64(n).map(Value::Number).ok_or_else(|| E::custom("Invalid number"))
    }

    fn child(self) -> Self {
        Self { depth: self.depth + 1, ..self }
    }
}

impl<'de> Visitor<'de> for Seed {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("finite JSON with unique object keys and bounded depth")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> { Ok(Value::Null) }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> { Ok(Value::Null) }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> { Ok(Value::Bool(value)) }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> { Ok(Value::String(String::from(value))) }
    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> { Ok(Value::String(value)) }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        if self.safe_integers && !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value) {
            return Err(E::custom("Unsafe integral value"));
        }
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        if self.safe_integers && value > 9_007_199_254_740_991 {
            return Err(E::custom("Unsafe integral value"));
        }
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> { self.number(value) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(self.child())? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("Duplicate JSON object key"));
            }
            let value = object.next_value_seed(self.child())?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

pub fn parse(input: &str, safe_integers: bool, max_depth: usize) -> Result<Value, serde_json::Error> {
    let mut decoder = serde_json::Deserializer::from_str(input);
    let value = Seed { depth: 0, max_depth, safe_integers }.deserialize(&mut decoder)?;
    decoder.end()?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ambiguous_and_unsafe_values() {
        for source in [r#"{"x":1,"x":2}"#, r#"{"x":"\ud800"}"#, "9007199254740992", "-9007199254740992", "1e999"] {
            assert!(parse(source, true, 32).is_err(), "{source}");
        }
        assert!(parse("9007199254740991", true, 32).is_ok());
        assert!(parse("-9007199254740991", true, 32).is_ok());
        assert_eq!(parse("-0", true, 32).unwrap().as_f64(), Some(0.0));
        assert!(parse("[[[0]]]", true, 2).is_err());
    }
}
