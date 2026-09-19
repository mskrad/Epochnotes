//! A minimal program around the `withdraw_excess` template, so that the template is tested on a validator.

use anchor_lang::prelude::*;

mod withdraw_excess;
use withdraw_excess::*;

declare_id!("HFoLn9V9XRzMUEi6SnLSunsq7XS32tfwt2k8EoN8GuXq");

#[program]
pub mod rent_example {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.vault.authority = ctx.accounts.authority.key();
        Ok(())
    }

    pub fn withdraw_excess(ctx: Context<WithdrawExcess>) -> Result<()> {
        withdraw_excess::withdraw_excess(ctx)
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + Vault::INIT_SPACE, seeds = [b"vault", authority.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    pub payload: [u8; 64],
}
