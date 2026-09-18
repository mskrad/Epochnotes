use anchor_lang::prelude::*;

declare_id!("Diad4BcYWeB3Epgma7RZFNWspm5gpdtTLnwoj3UWEcdy");

/// Registry of publishers and their append-only version log. Instructions arrive with the
/// on-chain anchoring task; the skeleton only proves the toolchain builds.
#[program]
pub mod registry {}
