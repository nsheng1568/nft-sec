// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.4;

/**
 * @title ContractKeys
 * @author NFTfi
 * @dev Common library for contract keys
 */
library ContractKeys {
    bytes32 internal constant PERMITTED_ERC20S = bytes32("PERMITTED_ERC20S");
    bytes32 internal constant PERMITTED_NFTS = bytes32("PERMITTED_NFTS");
    bytes32 internal constant PERMITTED_PARTNERS = bytes32("PERMITTED_PARTNERS");
    bytes32 internal constant NFT_TYPE_REGISTRY = bytes32("NFT_TYPE_REGISTRY");
    bytes32 internal constant LOAN_REGISTRY = bytes32("LOAN_REGISTRY");
    bytes32 internal constant PERMITTED_SNFT_RECEIVER = bytes32("PERMITTED_SNFT_RECEIVER");
    bytes32 internal constant PERMITTED_BUNDLE_ERC20S = bytes32("PERMITTED_BUNDLE_ERC20S");
    bytes32 internal constant PERMITTED_AIRDROPS = bytes32("PERMITTED_AIRDROPS");
    bytes32 internal constant AIRDROP_RECEIVER = bytes32("AIRDROP_RECEIVER");
    bytes32 internal constant AIRDROP_FACTORY = bytes32("AIRDROP_FACTORY");
    bytes32 internal constant AIRDROP_FLASH_LOAN = bytes32("AIRDROP_FLASH_LOAN");
    bytes32 internal constant NFTFI_BUNDLER = bytes32("NFTFI_BUNDLER");

    string internal constant AIRDROP_WRAPPER_STRING = "AirdropWrapper";

    /**
     * @notice Returns the bytes32 representation of a string
     * @param _key the string key
     * @return id bytes32 representation
     */
    function getIdFromStringKey(string memory _key) internal pure returns (bytes32 id) {
        require(bytes(_key).length <= 32, "invalid key");

        // solhint-disable-next-line no-inline-assembly
        assembly {
            id := mload(add(_key, 32))
        }
    }
}