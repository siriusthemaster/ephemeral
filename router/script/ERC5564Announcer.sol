// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Same event and behaviour as the canonical ERC-5564 Announcer (0x55649E01B5Df198D18D95b5cc5051630cfD45564):
///         it only emits. LocalSetup puts this code at the canonical address on a local anvil chain.
contract ERC5564Announcer {
    event Announcement(
        uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
