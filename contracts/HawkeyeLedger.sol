// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HawkeyeLedger — tamper-evident election observation ledger
/// @notice On-chain mirror of the Hawkeye backend rules:
///         - only accredited observers may submit
///         - every submission needs a location attestation signed by the oracle
///         - one submission per observer per polling unit, forever
///         - identical vote-vectors accumulate weight; the leading group and a
///           confidence figure are readable by anyone
///         Full vote data travels in event logs (cheap, permanent, indexable);
///         only hashes and weights live in contract storage.
/// @dev    Intended for a permissioned PoA network whose validators are
///         independent organisations (CSOs, media houses) — not a public mainnet.
contract HawkeyeLedger {
    address public immutable registrar; // accredits observers, rotates the oracle
    address public oracle;              // backend location-attestation signer

    mapping(address => bool) public isObserver;
    /// puHash => observer => already submitted?
    mapping(bytes32 => mapping(address => bool)) public hasSubmitted;
    /// puHash => votesHash => accumulated observer weight
    mapping(bytes32 => mapping(bytes32 => uint256)) public groupWeight;
    mapping(bytes32 => uint256) public totalWeight;
    mapping(bytes32 => bytes32) public leadingGroup;

    event ObserverRegistered(address indexed observer);
    event ObserverRevoked(address indexed observer);
    event SubmissionRecorded(
        bytes32 indexed puHash,
        address indexed observer,
        bytes32 votesHash,
        string puCode,
        string votesJson, // canonical sorted [{party,count}] — full data for indexers
        string imageRef   // IPFS CID or sha256 of the result-sheet photo
    );
    event LedgerAnchored(bytes32 head, uint256 entries, uint256 at);

    modifier onlyRegistrar() {
        require(msg.sender == registrar, "not registrar");
        _;
    }

    constructor(address _oracle) {
        registrar = msg.sender;
        oracle = _oracle;
    }

    function setOracle(address _oracle) external onlyRegistrar {
        oracle = _oracle;
    }

    function registerObserver(address observer) external onlyRegistrar {
        isObserver[observer] = true;
        emit ObserverRegistered(observer);
    }

    function revokeObserver(address observer) external onlyRegistrar {
        isObserver[observer] = false;
        emit ObserverRevoked(observer);
    }

    /// @notice Record one observed result. Reverts unless the oracle attested that
    ///         this observer stood at this unit with this exact data, recently.
    /// @param attestedAt unix seconds at which the oracle issued the attestation
    /// @param oracleSig  65-byte eth_sign signature over
    ///                   keccak256(observer, puHash, votesHash, keccak256(imageRef), attestedAt)
    function submitResult(
        string calldata puCode,
        string calldata votesJson,
        string calldata imageRef,
        uint256 attestedAt,
        bytes calldata oracleSig
    ) external {
        require(isObserver[msg.sender], "not an accredited observer");

        bytes32 puHash = keccak256(bytes(puCode));
        require(!hasSubmitted[puHash][msg.sender], "already submitted for this unit");
        require(
            block.timestamp <= attestedAt + 1 hours && attestedAt <= block.timestamp + 5 minutes,
            "stale attestation"
        );

        bytes32 votesHash = keccak256(bytes(votesJson));
        bytes32 digest = keccak256(
            abi.encodePacked(msg.sender, puHash, votesHash, keccak256(bytes(imageRef)), attestedAt)
        );
        require(_recover(_ethSignedHash(digest), oracleSig) == oracle, "invalid location attestation");

        hasSubmitted[puHash][msg.sender] = true;

        uint256 w = 1; // flat weight for the MVP; reputation weighting is the upgrade path
        totalWeight[puHash] += w;
        uint256 gw = groupWeight[puHash][votesHash] + w;
        groupWeight[puHash][votesHash] = gw;
        if (gw > groupWeight[puHash][leadingGroup[puHash]]) {
            leadingGroup[puHash] = votesHash;
        }

        emit SubmissionRecorded(puHash, msg.sender, votesHash, puCode, votesJson, imageRef);
    }

    /// @notice Leading result group for a unit. Confidence is in basis points (0–10000).
    function resultOf(string calldata puCode)
        external
        view
        returns (bytes32 votesHash, uint256 weight, uint256 total, uint256 confidenceBps)
    {
        bytes32 puHash = keccak256(bytes(puCode));
        votesHash = leadingGroup[puHash];
        weight = groupWeight[puHash][votesHash];
        total = totalWeight[puHash];
        confidenceBps = total == 0 ? 0 : (weight * 10000) / total;
    }

    /// @notice Anchor the backend's hash-chain head so off-chain history cannot be
    ///         rewritten unnoticed, even by the server operator.
    function anchorLedger(bytes32 head, uint256 entries) external {
        require(msg.sender == oracle || msg.sender == registrar, "not authorised");
        emit LedgerAnchored(head, entries, block.timestamp);
    }

    function _ethSignedHash(bytes32 h) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "bad signature length");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }
}
