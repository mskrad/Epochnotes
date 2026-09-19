//! Registry of publishers and their append-only version logs.
//!
//! A publisher's log is linear: version `n` must name the Merkle root of version `n - 1` as its
//! `prev_root`, and `n` grows by exactly one. The chain cannot be truncated or forked, so a client that
//! reads it learns two things signatures alone cannot give: how many versions exist, and which root
//! each of them has.

use anchor_lang::prelude::*;

declare_id!("Diad4BcYWeB3Epgma7RZFNWspm5gpdtTLnwoj3UWEcdy");

pub const MAX_NAME_BYTES: usize = 32;
pub const MAX_URI_BYTES: usize = 200;
pub const MAX_ENTRY_ID_BYTES: usize = 64;
/// `prev_root` of a publisher's first version: there is nothing before it.
pub const GENESIS_ROOT: [u8; 32] = [0; 32];

#[program]
pub mod registry {
    use super::*;

    /// Creates the registry and names the admin who admits publishers.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admits a publisher key. Only the admin can do this.
    pub fn register_publisher(ctx: Context<RegisterPublisher>, authority: Pubkey, name: String) -> Result<()> {
        require!(!name.is_empty() && name.len() <= MAX_NAME_BYTES, RegistryError::InvalidName);
        let publisher = &mut ctx.accounts.publisher;
        publisher.authority = authority;
        publisher.name = name;
        publisher.active = true;
        publisher.admitted_by = ctx.accounts.admin.key();
        publisher.version_count = 0;
        publisher.latest_root = GENESIS_ROOT;
        publisher.bump = ctx.bumps.publisher;
        Ok(())
    }

    /// Suspends or restores a publisher. Versions published while it was active stay valid.
    pub fn set_publisher_active(ctx: Context<SetPublisherActive>, active: bool) -> Result<()> {
        ctx.accounts.publisher.active = active;
        Ok(())
    }

    /// Appends version `n` to the publisher's log.
    pub fn publish_version(ctx: Context<PublishVersion>, n: u64, args: VersionArgs) -> Result<()> {
        let publisher = &mut ctx.accounts.publisher;
        require!(publisher.active, RegistryError::PublisherNotActive);
        require!(n == publisher.version_count + 1, RegistryError::VersionOutOfOrder);
        require!(args.prev_root == publisher.latest_root, RegistryError::BrokenChain);
        require!(args.entry_count > 0, RegistryError::EmptyVersion);
        require!(!args.uri.is_empty() && args.uri.len() <= MAX_URI_BYTES, RegistryError::InvalidUri);

        let version = &mut ctx.accounts.version;
        version.publisher = publisher.authority;
        version.n = n;
        version.merkle_root = args.merkle_root;
        version.prev_root = args.prev_root;
        version.content_hash = args.content_hash;
        version.entry_count = args.entry_count;
        version.uri = args.uri;
        // Informational only: slots are not a clock.
        version.slot = Clock::get()?.slot;
        version.bump = ctx.bumps.version;

        publisher.version_count = n;
        publisher.latest_root = args.merkle_root;
        Ok(())
    }

    /// Records that the publisher withdrew an entry. `entry_id_hash` is sha256 of the entry id.
    pub fn revoke_entry(ctx: Context<RevokeEntry>, entry_id_hash: [u8; 32], entry_id: String) -> Result<()> {
        require!(!entry_id.is_empty() && entry_id.len() <= MAX_ENTRY_ID_BYTES, RegistryError::InvalidEntryId);
        require!(
            solana_sha256_hasher::hash(entry_id.as_bytes()).to_bytes() == entry_id_hash,
            RegistryError::InvalidEntryId
        );
        let publisher = &ctx.accounts.publisher;
        require!(publisher.active, RegistryError::PublisherNotActive);
        let revocation = &mut ctx.accounts.revocation;
        revocation.publisher = publisher.authority;
        revocation.entry_id = entry_id;
        revocation.at_version = publisher.version_count;
        revocation.slot = Clock::get()?.slot;
        revocation.bump = ctx.bumps.revocation;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct VersionArgs {
    pub merkle_root: [u8; 32],
    pub prev_root: [u8; 32],
    pub content_hash: [u8; 32],
    pub entry_count: u32,
    pub uri: String,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Publisher {
    pub authority: Pubkey,
    #[max_len(MAX_NAME_BYTES)]
    pub name: String,
    pub active: bool,
    pub admitted_by: Pubkey,
    pub version_count: u64,
    pub latest_root: [u8; 32],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RegistryVersion {
    pub publisher: Pubkey,
    pub n: u64,
    pub merkle_root: [u8; 32],
    pub prev_root: [u8; 32],
    pub content_hash: [u8; 32],
    pub entry_count: u32,
    #[max_len(MAX_URI_BYTES)]
    pub uri: String,
    pub slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Revocation {
    pub publisher: Pubkey,
    #[max_len(MAX_ENTRY_ID_BYTES)]
    pub entry_id: String,
    /// The publisher's latest version when the entry was withdrawn.
    pub at_version: u64,
    pub slot: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(authority: Pubkey)]
pub struct RegisterPublisher<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ RegistryError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Publisher::INIT_SPACE, seeds = [b"publisher", authority.as_ref()], bump)]
    pub publisher: Account<'info, Publisher>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPublisherActive<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ RegistryError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"publisher", publisher.authority.as_ref()], bump = publisher.bump)]
    pub publisher: Account<'info, Publisher>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(n: u64)]
pub struct PublishVersion<'info> {
    #[account(mut, seeds = [b"publisher", authority.key().as_ref()], bump = publisher.bump, has_one = authority @ RegistryError::NotPublisher)]
    pub publisher: Account<'info, Publisher>,
    #[account(init, payer = authority, space = 8 + RegistryVersion::INIT_SPACE, seeds = [b"version", authority.key().as_ref(), &n.to_le_bytes()], bump)]
    pub version: Account<'info, RegistryVersion>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(entry_id_hash: [u8; 32])]
pub struct RevokeEntry<'info> {
    #[account(seeds = [b"publisher", authority.key().as_ref()], bump = publisher.bump, has_one = authority @ RegistryError::NotPublisher)]
    pub publisher: Account<'info, Publisher>,
    #[account(init, payer = authority, space = 8 + Revocation::INIT_SPACE, seeds = [b"revoked", authority.key().as_ref(), entry_id_hash.as_ref()], bump)]
    pub revocation: Account<'info, Revocation>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum RegistryError {
    #[msg("Only the registry admin can do this")]
    NotAdmin,
    #[msg("The signer is not the authority of this publisher")]
    NotPublisher,
    #[msg("The publisher is not active")]
    PublisherNotActive,
    #[msg("Version number must be the publisher's version count plus one")]
    VersionOutOfOrder,
    #[msg("prev_root must equal the Merkle root of the publisher's previous version")]
    BrokenChain,
    #[msg("A version holds at least one entry")]
    EmptyVersion,
    #[msg("Name must be 1 to 32 bytes")]
    InvalidName,
    #[msg("URI must be 1 to 200 bytes")]
    InvalidUri,
    #[msg("Entry id must be 1 to 64 bytes and match its hash")]
    InvalidEntryId,
}
