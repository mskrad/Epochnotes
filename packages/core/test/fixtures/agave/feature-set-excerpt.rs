// An excerpt of agave feature-set/src/lib.rs at 56379e3332c166b0de75b7e45ea1d63dd6755f30, lines kept as they are.
use {
    ahash::{AHashMap, AHashSet},
    solana_pubkey::Pubkey,
    std::sync::LazyLock,
};

pub mod full_inflation {
    pub mod devnet_and_testnet {
        solana_pubkey::declare_id!("DT4n6ABDqs6w4bnfwrXT9rsprcPf6cdDga1egctaPkLC");
    }

    pub mod mainnet {
        pub mod certusone {
            pub mod vote {
                solana_pubkey::declare_id!("BzBBveUDymEYoYzcMWNQCx3cd4jQs7puaVFHLtsbB6fm");
            }
            pub mod enable {
                solana_pubkey::declare_id!("7XRJcS5Ud5vxGB54JbK9N2vBZVwnwdBNeJW1ibRgD9gx");
            }
        }
    }
}

pub mod secp256k1_program_enabled {
    solana_pubkey::declare_id!("E3PHP7w8kB7np3CTQ1qQ2tW3KCtjRSXBQgW9vM2mWv2Y");
}

pub mod credits_auto_rewind {
    solana_pubkey::declare_id!("BUS12ciZ5gCoFafUHWW8qaFMMtwFQGVxjsDheWLdqBE2");
}

pub mod alpenglow {
    solana_pubkey::declare_id!("A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS");
}

pub mod vote_state_v4 {
    solana_pubkey::declare_id!("Gx4XFcrVMt4HUvPzTpTSVkdDVgcDSjKhDN1RqRS6KDuZ");

    pub mod stake_program_buffer {
        solana_pubkey::declare_id!("BM11F4hqrpinQs28sEZfzQ2fYddivYs4NEAHF6QMjkJF");
    }
}

pub mod upgrade_bpf_stake_program_to_v5 {
    solana_pubkey::declare_id!("STk5Xj8hdAx3sTzmtJ3QysKkq6X2A3yj73JtxttiRyk");

    pub mod buffer {
        solana_pubkey::declare_id!("4EBQBjw1kqF1dqUBb6fc5Ji4tCEQgNf9ESGGX3smwXwh");
    }
}

pub mod reduce_slot_time_to_200ms {
    solana_pubkey::declare_id!("iBRLjhJnkmDZgNoZRDMW11d8ZV7HvsL3vAyRjZB5npW");
}

pub static FEATURE_NAMES: LazyLock<AHashMap<Pubkey, &'static str>> = LazyLock::new(|| {
    [
        (secp256k1_program_enabled::id(), "secp256k1 program"),
        (
            full_inflation::devnet_and_testnet::id(),
            "full inflation on devnet and testnet",
        ),
        (
            full_inflation::mainnet::certusone::enable::id(),
            "full inflation enabled by Certus One",
        ),
        (
            full_inflation::mainnet::certusone::vote::id(),
            "community vote allowing Certus One to enable full inflation",
        ),
        (
            credits_auto_rewind::id(),
            "Auto rewind stake's credits_observed if (accidental) vote recreation is detected \
             #22546",
        ),
        (
            alpenglow::id(),
            "SIMD-0326: Alpenglow: new consensus algorithm",
        ),
        (vote_state_v4::id(), "SIMD-0185: Vote State v4"),
        (
            upgrade_bpf_stake_program_to_v5::id(),
            "SIMD-0490: Upgrade BPF Stake Program to v5.0.0",
        ),
        (
            reduce_slot_time_to_200ms::id(),
            "SIMD-0525: Reduce slot time to 200ms",
        ),
    ]
    .iter()
    .cloned()
    .collect()
});

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_full_inflation_features_enabled_devnet_and_testnet() {
        let mut feature_set = FeatureSet::default();
        assert!(feature_set.full_inflation_features_enabled().is_empty());
        feature_set
            .active
            .insert(full_inflation::devnet_and_testnet::id(), 42);
    }
}
